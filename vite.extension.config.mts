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
        // Wasm/native engines loaded at runtime from node_modules by absolute
        // path: 7zz.cjs resolves 7zz.wasm and its pthread worker next to
        // itself, the rar-rs loader its .wasm — keep both trees unbundled.
        /7zip-zstd-wasm/,
        /@yjdyamv\/rar-rs/,
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
      ],
    },
  },
  resolve: {
    mainFields: ["main", "module"],
  },
});
