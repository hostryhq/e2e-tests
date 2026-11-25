import { readFileSync } from "node:fs";
import type { Mutation } from "@hostry/client-core";
import { demoRows } from "../../../../app-restaurant/src/fixtures/demo-outlet";
import type { Dev, Fixture, SoakNet } from "./net";

/**
 * The app seeds a demo outlet with one op, `seed.demo`, which is not in the intent registry: the gateway quarantines it
 * (`intent_not_allowed`) and no other device would ever receive the menu. In production the same rows arrive through
 * legal routes, and this publishes them through exactly those routes:
 *  - device intents recorded by a manager on the counter (floor.manage, menu.*.edit, settings.outlet.edit, ...), and
 *  - cloud-origin intents emitted through the gateway's emit API by the owning service, with that service's own key
 *    (billing: settings and tax rules). The rows are the app's own demo rows; nothing is invented here.
 */
const DEVICE_ROUTE: Array<[intent: string, entities: string[]]> = [
  ["floor.manage", ["floor", "dining_table"]],
  ["menu.category.edit", ["category"]],
  ["menu.item.edit", ["item", "item_variant", "item_modifier_group"]],
  ["menu.modifier.edit", ["modifier_group", "modifier"]],
  ["menu.price.set", ["price_entry"]],
  ["settings.reason.edit", ["reason_code"]],
  ["settings.outlet.edit", ["station", "tender_kind", "item_outlet", "outlet_settings", "receipt_profile"]],
];
/** Entities no device intent may write (cloud-origin only), with the cloud intent that carries them. */
const CLOUD_ROUTE: Array<[intent: string, authorisedBy: string, stream: "outlet" | "tenant", entities: string[]]> = [
  ["settings.tax_profile.set", "settings.gst_profile.edit", "outlet", ["outlet_tax_profile"]],
  ["settings.numbering.set", "settings.numbering.edit", "outlet", ["billing_settings"]],
  ["tax.rule_set.publish", "admin.taxrules.publish", "tenant", ["tax_rule_set", "tax_rule"]],
];

const b64u = (b: ArrayBuffer | Uint8Array): string => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");

/** A 60-second service token signed with the stack's own key for that service (kid and iss are the service name). */
export async function serviceToken(service: string, audience: string, tenant: string): Promise<string> {
  const pem = readFileSync(`${process.env.SOAK_STATE ?? "/tmp/hostry-soak/local"}/keys/${service}.key`, "utf8");
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(new TextEncoder().encode(JSON.stringify({ alg: "ES256", typ: "JWT", kid: service })));
  const body = b64u(new TextEncoder().encode(JSON.stringify({ iss: service, aud: [audience], sub: service, typ: "service", tid: tenant, iat: now, exp: now + 55, jti: crypto.randomUUID() })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64u(sig)}`;
}

export type EmitOp = { key: string; stream: string; intent: string; intent_v: number; muts: Mutation[]; pii: unknown; actor: string; authorised_by: string | null; approval: string };

/** POST /internal/v1/emit as the owning service. Returns the HTTP status and body (a refusal is evidence, not an exception). */
export async function emit(fx: Fixture, caller: string, ops: EmitOp[]): Promise<{ status: number; body: string }> {
  const tok = await serviceToken(caller, "sync", fx.tenant_id);
  const r = await fetch(`${fx.cloud_url}/internal/v1/emit`, {
    method: "POST",
    headers: { "content-type": "application/json", "Hostry-Service-Token": tok, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ tenant_id: fx.tenant_id, ops }),
  });
  return { status: r.status, body: await r.text() };
}

const muts = (rows: Array<{ id: string } & Record<string, unknown>>, entity: string): Mutation[] =>
  rows.map((row): Mutation => {
    const f: Record<string, unknown> = { ...row };
    delete f.id;
    delete f.tenant_id;
    return { e: entity, id: row.id, k: "insert", f };
  });

export type ConfigReport = { device_ops: Array<{ intent: string; ok: boolean; error?: string }>; emits: Array<{ intent: string; status: number; body: string }> };

/** Publish the demo outlet's configuration through legal routes; `numberAt` is the outlet's numbering mode (ADR-0014 A1.5). */
export async function publishConfig(net: SoakNet, counter: Dev, numberAt: "settle" | "print"): Promise<ConfigReport> {
  const rows = demoRows(net.fx.outlet_id) as unknown as Record<string, Array<{ id: string } & Record<string, unknown>>>;
  const report: ConfigReport = { device_ops: [], emits: [] };
  await counter.signIn("Anand");
  for (const [intent, entities] of DEVICE_ROUTE) {
    const all = entities.flatMap((e) => muts(rows[e] ?? [], e));
    if (all.length === 0) continue;
    try {
      await counter.rt.writer.record({ intent, build: () => all });
      report.device_ops.push({ intent, ok: true });
    } catch (e) {
      report.device_ops.push({ intent, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  counter.rt.setSession(undefined);
  for (const [intent, by, stream, entities] of CLOUD_ROUTE) {
    const all = entities.flatMap((e) => {
      let r = rows[e] ?? [];
      // manual_book_codes is a nested array the entity contract does not have ("not an entity field yet" in seed.ts):
      // the emit API refuses nested values, so it is left out of the cloud row (reported as a finding).
      if (e === "billing_settings") r = r.map(({ manual_book_codes: _m, ...x }) => ({ ...x, number_at: numberAt }));
      return muts(r, e);
    });
    const res = await emit(net.fx, "billing", [
      { key: `soak-config-${intent}`, stream: `${stream}:${stream === "tenant" ? net.fx.tenant_id : net.fx.outlet_id}`, intent, intent_v: 1, muts: all, pii: null, actor: net.S("Anand").id, authorised_by: by, approval: "" },
    ]);
    report.emits.push({ intent, status: res.status, body: res.body.slice(0, 300) });
  }
  return report;
}
