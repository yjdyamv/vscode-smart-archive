import { builtinModules } from "module";
import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(__dirname, "src/extension.ts"),
      formats: ["cjs"],
      fileName: () => "extension.js",
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
        "brotli-wasm",
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
