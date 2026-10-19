import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./web", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
    license: { fileName: ".vite/third-party-licenses.json" },
  },
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
});
