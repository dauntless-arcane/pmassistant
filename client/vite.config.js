import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // Loads client/.env (and friends) so the dev server port and API proxy
  // target can move without touching this file.
  const env = loadEnv(mode, process.cwd(), "");
  const clientPort = Number(env.CLIENT_PORT) || 5173;
  const serverPort = Number(env.SERVER_PORT) || 4000;

  return {
    plugins: [react()],
    server: {
      port: clientPort,
      proxy: {
        "/api": `http://localhost:${serverPort}`,
      },
    },
  };
});
