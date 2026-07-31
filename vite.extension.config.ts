import { builtinModules } from "module";
import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  build: {
    lib: {
      entry: {
        extension: path.resolve(__dirname, "src/extension.ts"),
        "worker/worker": path.resolve(__dirname, "src/engines/worker/worker.ts"),
      },
      formats: ["cjs"],
      fileName: (format, entryName) => `${entryName}.js`,
    },
    outDir: "out",
    emptyOutDir: true,
    sourcemap: process.env.SOURCEMAP === "true",
    minify: false,
    rollupOptions: {
      external: [
        "vscode",
        "zstd-napi",
        "lz4-napi",
        "snappy",
        "js7z-tools",
        "@vscode/codicons",
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
      ],
    },
  },
  resolve: {
    mainFields: ["main", "module"],
  },
});
