// ---------------------------------------------------------------------------
// Environment metadata collection for $startup events.
//
// Branches between browser and server to capture the most useful
// debugging and segmentation data for each runtime.
//
// Browser: screen, viewport, locale, connection quality, input mode,
//          color scheme, referrer, URL.
// Server:  OS, architecture, CPU, memory, cloud provider, Node version.
// ---------------------------------------------------------------------------

// Ambient globals for runtime detection.
declare const Deno: unknown;
declare const Bun: unknown;
declare const EdgeRuntime: unknown;
declare const process: undefined | {
  versions?: { node?: string };
  platform?: string;
  arch?: string;
  memoryUsage?: () => { rss: number };
  env?: Record<string, string | undefined>;
};

export function detectPlatform(): string {
  if (typeof Deno !== "undefined") return "deno";
  if (typeof Bun !== "undefined") return "bun";
  if (typeof EdgeRuntime !== "undefined") return "edge";
  if (typeof window !== "undefined" && typeof document !== "undefined") return "browser";
  if (typeof process !== "undefined" && process.versions?.node) return "node";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Browser context (like Sentry's httpContext + cultureContext)
// ---------------------------------------------------------------------------

function browserContext(): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};

  if (typeof navigator !== "undefined") {
    ctx.user_agent = navigator.userAgent;
    ctx.language = navigator.language;
    ctx.languages = navigator.languages ? [...navigator.languages] : undefined;
    ctx.online = navigator.onLine;
    ctx.hardware_concurrency = navigator.hardwareConcurrency;
    ctx.touch = navigator.maxTouchPoints > 0;

    // Network Information API (Chromium)
    const conn = (navigator as Record<string, unknown>).connection as
      | { effectiveType?: string; downlink?: number; rtt?: number }
      | undefined;
    if (conn) {
      ctx.connection_type = conn.effectiveType;
      ctx.connection_downlink = conn.downlink;
      ctx.connection_rtt = conn.rtt;
    }
  }

  if (typeof window !== "undefined") {
    // Screen (physical display)
    if (window.screen) {
      ctx.screen_width = window.screen.width;
      ctx.screen_height = window.screen.height;
    }
    // Viewport (visible area, what the user actually sees)
    ctx.viewport_width = window.innerWidth;
    ctx.viewport_height = window.innerHeight;
    ctx.device_pixel_ratio = window.devicePixelRatio;

    if (window.location) {
      ctx.page_url = window.location.href;
    }

    // User preferences
    if (typeof window.matchMedia === "function") {
      ctx.prefers_color_scheme = window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
      ctx.prefers_reduced_motion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
  }

  if (typeof document !== "undefined") {
    ctx.referrer = document.referrer || undefined;
  }

  // Locale / timezone (Sentry's cultureContext)
  if (typeof Intl !== "undefined") {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    ctx.timezone = resolved.timeZone;
    ctx.locale = resolved.locale;
  }

  return ctx;
}

// ---------------------------------------------------------------------------
// Server context (like Sentry's NodeContext integration)
// ---------------------------------------------------------------------------

/** Detect cloud/serverless provider from environment variables.
 *  Same approach as Sentry's cloud_resource context. */
function detectCloud(env: Record<string, string | undefined>): Record<string, unknown> | undefined {
  // Order matters: more specific checks first.
  if (env.VERCEL) return { cloud_provider: "vercel", cloud_region: env.VERCEL_REGION };
  if (env.AWS_REGION) return { cloud_provider: "aws", cloud_region: env.AWS_REGION, cloud_platform: env.AWS_EXECUTION_ENV };
  if (env.FLY_REGION) return { cloud_provider: "fly", cloud_region: env.FLY_REGION };
  if (env.RAILWAY_ENVIRONMENT_NAME) return { cloud_provider: "railway", cloud_environment: env.RAILWAY_ENVIRONMENT_NAME };
  if (env.RENDER) return { cloud_provider: "render", cloud_region: env.RENDER_REGION };
  if (env.GCP_PROJECT || env.GOOGLE_CLOUD_PROJECT) return { cloud_provider: "gcp" };
  if (env.WEBSITE_SITE_NAME && env.REGION_NAME) return { cloud_provider: "azure", cloud_region: env.REGION_NAME };
  if (env.DYNO) return { cloud_provider: "heroku" };
  if (env.NETLIFY) return { cloud_provider: "netlify" };
  return undefined;
}

/** Detect CI environment from env vars (like Sentry's release detection). */
function detectCI(env: Record<string, string | undefined>): string | undefined {
  if (env.GITHUB_ACTIONS) return "github_actions";
  if (env.GITLAB_CI) return "gitlab_ci";
  if (env.CIRCLECI) return "circleci";
  if (env.BUILDKITE) return "buildkite";
  if (env.JENKINS_URL) return "jenkins";
  if (env.CODEBUILD_BUILD_ID) return "aws_codebuild";
  if (env.CI) return "unknown_ci";
  return undefined;
}

function serverContext(): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};

  if (typeof process === "undefined") return ctx;

  // Runtime
  ctx.node_version = process.versions?.node;
  ctx.os_platform = process.platform;
  ctx.arch = process.arch;

  // Memory (like Sentry's device.memory_size + app.app_memory)
  if (process.memoryUsage) {
    ctx.memory_rss = process.memoryUsage().rss;
  }

  // Timezone
  if (typeof Intl !== "undefined") {
    ctx.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  // Cloud + CI detection from env vars
  if (process.env) {
    const cloud = detectCloud(process.env);
    if (cloud) Object.assign(ctx, cloud);

    const ci = detectCI(process.env);
    if (ci) ctx.ci = ci;
  }

  return ctx;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Collect all environment metadata for the $startup event.
 *  Returns a flat object suitable for event metadata. */
export function collectStartupMetadata(): Record<string, unknown> {
  const platform = detectPlatform();
  return {
    platform,
    ...(platform === "browser" ? browserContext() : serverContext()),
  };
}
