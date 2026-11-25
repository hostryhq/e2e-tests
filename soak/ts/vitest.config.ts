import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";

/**
 * The soak drives the UNMODIFIED app-restaurant domain code (runtime, data/trading) as headless devices. Tenant, outlet, device,
 * series, staff and paper bill books now come from the device's offline pack (app-restaurant 09bf2db), so the earlier rewrites of
 * the demo constants and of the manual-book codes are gone. One build-time rewrite remains:
 *  - runtime.ts opens the sync engine on the outlet stream only and routes brand and tenant intents into it; the production
 *    topology (ADR-0002 S3) is three streams (outlet, brand, tenant). The pack carries no brand or tenant stream names and the
 *    app has no option for them, so the harness names them from the onboarded organisation (reported as a finding).
 */
const fx = JSON.parse(readFileSync(process.env.SOAK_FIXTURE ?? "", "utf8")) as { tenant_id: string; outlet_id: string; brand_id: string };
const APP = resolve(process.env.SOAK_APP_DIR ?? resolve(__dirname, "../../../app-restaurant"));

const rewire = (): Plugin => ({
  name: "soak-rewire",
  enforce: "pre",
  transform(code, id) {
    const p = id.replace(/\\/g, "/");
    if (p.endsWith("/app-restaurant/src/runtime.ts")) {
      const a = code.replace("streams: [outletStream, brandStream],", `streams: [outletStream, brandStream, ${JSON.stringify("tenant:" + fx.tenant_id)}],`);
      const b = a.replace("{ streams: { brand: brandStream, tenant: outletStream } }", `{ streams: { brand: brandStream, tenant: ${JSON.stringify("tenant:" + fx.tenant_id)} } }`);
      if (a === code || b === a) throw new Error("soak-rewire: runtime.ts no longer has the wiring this rewrite expects; remove or update the rewrite");
      return b;
    }
    return null;
  },
});

export default defineConfig({
  plugins: [rewire()],
  // Transformed output depends on the fixture; never share a cache between organisations.
  cacheDir: resolve(process.env.TMPDIR ?? "/tmp", `hostry-soak-vite-${fx.outlet_id}`),
  server: { fs: { allow: [APP, resolve(APP, ".."), resolve(__dirname, "../..")] } },
  test: {
    environment: "node",
    fsModuleCache: false, // the rewrite depends on the fixture; a cached transform of another organisation would leak its ids
    include: ["src/**/*.soak.ts"],
    testTimeout: 3_600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
