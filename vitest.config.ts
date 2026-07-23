import { defineConfig } from "vitest/config";
import * as path from "path";

export default defineConfig({
  test: {
    name: "extension",
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/globalSetup.ts"],
    environment: "node",
    globals: true,
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "test/__mocks__/vscode.ts"),
    },
  },
});
