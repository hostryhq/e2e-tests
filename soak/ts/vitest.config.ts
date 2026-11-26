import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * The soak drives the UNMODIFIED app-restaurant domain code (runtime, data/trading) as headless devices. Tenant, outlet, device,
 * series, staff, paper bill books, the three streams (outlet, brand, tenant) and the entitlement snapshot all come from the
 * device's offline pack (app-restaurant e2ed513). Run 4 removed the last build-time rewrite (F4b): there is none left.
 */
const fx = JSON.parse(readFileSync(process.env.SOAK_FIXTURE ?? "", "utf8")) as { tenant_id: string; outlet_id: string; brand_id: string };
const APP = resolve(process.env.SOAK_APP_DIR ?? resolve(__dirname, "../../../app-restaurant"));

export default defineConfig({
  cacheDir: resolve(process.env.TMPDIR ?? "/tmp", `hostry-soak-vite-${fx.outlet_id}`),
  server: { fs: { allow: [APP, resolve(APP, ".."), resolve(__dirname, "../..")] } },
  define: { __HOSTRY_TARGET__: JSON.stringify("browser"), __HOSTRY_RELEASE__: "false" },
  test: {
    environment: "node",
    include: ["src/**/*.soak.ts"],
    testTimeout: 3_600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
