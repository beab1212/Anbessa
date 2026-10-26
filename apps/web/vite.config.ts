import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// The app calls one origin: /api/* on itself. In development Vite forwards each prefix to its
// service (no CORS, and the auth cookies stay first-party); in production Kong does the same.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = (name: string, port: number) => env[name] ?? `http://localhost:${port}`;
  const auth = target("AUTH_URL", 3001);
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api/auth": auth,
        "/api/admin-auth": auth,
        "/api/identity": auth,
        "/api/dev": auth, // development sign-in (DEV_LOGIN=on in auth-service; never in production)
        "/api/trips": target("TRIP_URL", 3002),
        "/api/fleet": target("FLEET_URL", 3008),
        "/api/locations": target("LOCATION_URL", 3003),
        "/api/maps": target("MAPPING_URL", 3007),
      },
    },
  };
});
