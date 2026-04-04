import { defineConfig } from "vitest/config";
import pkg from "./package.json";

export default defineConfig({
  define: {
    __SDK_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // Playwright handles browser tests separately via playwright.config.ts.
    exclude: ["tests/browser/**"],
  },
});
