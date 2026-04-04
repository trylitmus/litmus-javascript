import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Playwright handles browser tests separately via playwright.config.ts.
    exclude: ["tests/browser/**"],
  },
});
