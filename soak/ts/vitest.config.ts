import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";

/**
 * The soak drives the UNMODIFIED app-restaurant domain code (runtime, data/trading) as headless devices. Two things in
 * that code are written for the demo outlet and have no configuration switch, so this build-time rewrite points them
 * at the organisation the run onboarded on the real services (both are reported as findings, nothing else is touched):
 *  1. data/seed.ts hard-codes TENANT_ID "tenant-1" and OUTLET_ID "outlet-1"; the real services issue UUIDs.
 *  2. runtime.ts opens the sync engine on the outlet stream only and routes brand and tenant intents into it; the
 *     production topology (ADR-0002 S3) is three streams (outlet, brand, tenant).
 */
const fx = JSON.parse(readFileSync(process.env.SOAK_FIXTURE ?? "", "utf8")) as { tenant_id: string; outlet_id: string; brand_id: string };
const APP = resolve(process.env.SOAK_APP_DIR ?? resolve(__dirname, "../../../app-restaurant"));

const rewire = (): Plugin => ({
  name: "soak-rewire",
  enforce: "pre",
  transform(code, id) {
    const p = id.replace(/\\/g, "/");
    if (p.endsWith("/app-restaurant/src/data/seed.ts")) {
      return code.replace('export const TENANT_ID = "tenant-1";', `export const TENANT_ID = ${JSON.stringify(fx.tenant_id)};`).replace('export const OUTLET_ID = "outlet-1";', `export const OUTLET_ID = ${JSON.stringify(fx.outlet_id)};`);
    }
    if (p.endsWith("/app-restaurant/src/runtime.ts")) {
      const streams = JSON.stringify([`outlet:${fx.outlet_id}`, `brand:${fx.brand_id}`, `tenant:${fx.tenant_id}`]);
      return code
        .replace("outletStream: OUTLET_STREAM,\n    signer,", `outletStream: OUTLET_STREAM,\n    streams: ${streams},\n    signer,`)
        .replace("{ streams: { brand: OUTLET_STREAM, tenant: OUTLET_STREAM } }", `{ streams: { brand: ${JSON.stringify("brand:" + fx.brand_id)}, tenant: ${JSON.stringify("tenant:" + fx.tenant_id)} } }`);
    }
    if (p.endsWith("/app-restaurant/src/data/context.ts")) {
      // 3. The paper bill books of the outlet reach the app only as a nested billing_settings field that the entity contract
      //    does not have (and the cloud refuses). Tenancy registered MB1 for this outlet (soak-onboard); tell the app.
      return code.replace("manualBookCodes: billing.manual_book_codes ?? [],", 'manualBookCodes: billing.manual_book_codes ?? ["MB1"],');
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
