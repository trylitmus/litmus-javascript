import { defineConfig } from "vitest/config";
import pkg from "./package.json";

const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);

export default defineConfig({
  define: {
    __SDK_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // Playwright handles browser tests separately via playwright.config.ts.
    exclude: ["tests/browser/**"],
    // Node 25+ ships a global localStorage that shadows jsdom's real implementation.
    // --no-experimental-webstorage disables it so jsdom tests work correctly.
    // https://github.com/vitest-dev/vitest/issues/8757
    pool: "forks",
    poolOptions: {
      forks: {
        execArgv: nodeMajor >= 25 ? ["--no-experimental-webstorage"] : [],
      },
    },
  },
});
