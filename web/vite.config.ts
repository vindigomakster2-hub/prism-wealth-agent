import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Local-only by default. To open the app from another device, set ABANQ_ALLOWED_HOSTS in the repo-root
// .env (README → "Open it from another laptop"): the dev server then listens on the network and accepts
// only those host names. The API checks the same list, so both layers agree.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL("..", import.meta.url)), "");
  const hosts = (env.ABANQ_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  const host = hosts.length ? "0.0.0.0" : "127.0.0.1";
  const proxy = { "/api": "http://127.0.0.1:8787" };
  return {
    plugins: [react()],
    server: { host, allowedHosts: hosts, proxy },
    preview: { host, allowedHosts: hosts, proxy },
  };
});
