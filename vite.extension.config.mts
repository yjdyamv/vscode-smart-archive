import { builtinModules } from "module";
import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  build: {
    lib: {
      entry: {
        extension: path.resolve(import.meta.dirname, "src/extension.ts"),
        "worker/worker": path.resolve(import.meta.dirname, "src/engines/worker/worker.ts"),
      },
      formats: ["cjs"],
      fileName: (format, entryName) => `${entryName}.js`,
    },
    outDir: "out",
    emptyOutDir: true,
    sourcemap: process.env.SOURCEMAP === "true",
    minify: false,
    rollupOptions: {
      output: {
        // Stable filenames for shared chunks (no content hash): the worker
        // entry requires them by relative path — deterministic names keep
        // the require predictable.
        chunkFileNames: (chunkInfo) =>
          chunkInfo.name === "rolldown-runtime" ? "rolldown-runtime.js" : "shared-core.js",
      },
      external: [
        "vscode",
        "snappy",
        "@vscode/codicons",
        // vendored wasm engine — loaded at runtime via relative require so
        // 7zz.js can resolve 7zz.wasm next to itself (__dirname)
        /\/vendor\/7zz-wasm\//,
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
      ],
    },
  },
  resolve: {
    mainFields: ["main", "module"],
  },
});
