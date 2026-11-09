import { defineConfig } from "vite";
import path from "node:path";

// GitHub Pages serves the site at /keyhole/. Override with KH_BASE for other hosts.
export default defineConfig({
  base: process.env.KH_BASE ?? "/keyhole/",
  resolve: { alias: { "@keyhole/core": path.resolve(__dirname, "../packages/core/src/index.ts") } },
  server: { fs: { allow: [".."] } },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true, reportCompressedSize: true, chunkSizeWarningLimit: 400 },
});
