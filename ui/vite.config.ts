import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Optional development proxy: CODEC_DASHBOARD_URL must be an explicitly chosen
// running dashboard URL (including ?token=...). Never default to the owner's port.
const dashboard = process.env.CODEC_DASHBOARD_URL;
if (dashboard) {
  const url = new URL(dashboard);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.protocol !== "http:") {
    throw new Error("CODEC_DASHBOARD_URL must be a local http dashboard link.");
  }
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "codec-development-token",
      // Never put the development token in a production build.
      apply: "serve",
      transformIndexHtml(html) {
        const token = dashboard ? new URL(dashboard).searchParams.get("token") : null;
        return html.replaceAll("__CODEC_TOKEN__", (token ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!));
      },
    },
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: fileURLToPath(new URL("../dist/ui", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: dashboard ? { "/api": { target: new URL(dashboard).origin, changeOrigin: true } } : undefined,
  },
});
