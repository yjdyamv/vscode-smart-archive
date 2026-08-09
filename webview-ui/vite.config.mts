import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { devThemePlugin } from "./devThemePlugin.ts";

export default defineConfig({
  plugins: [vue(), tailwindcss(), devThemePlugin()],
  base: "./",
  build: {
    outDir: "../media/vue",
    emptyOutDir: true,
    sourcemap: process.env.SOURCEMAP === "true",
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: "assets/index.js",
        chunkFileNames: "assets/chunk-[name].js",
        assetFileNames: "assets/[name].[ext]",
        manualChunks: undefined,
      },
    },
  },
  define: {
    __VUE_PROD_DEVTOOLS__: false,
  },
});
