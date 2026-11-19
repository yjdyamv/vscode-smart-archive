import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

// Force the test (development) Vue build. If NODE_ENV is inherited as
// "production" — as it is in some shells and CI — Vite compiles Vue's prod
// bundle, which drops the DevTools `component:emit` events that
// @vue/test-utils records `emitted(...)` from, so every emit assertion would
// silently read undefined while DOM assertions still pass.
process.env.NODE_ENV = "test";

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
  },
});
