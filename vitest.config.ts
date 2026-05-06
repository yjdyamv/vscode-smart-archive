import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "extension",
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: true,
    testTimeout: 60_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
