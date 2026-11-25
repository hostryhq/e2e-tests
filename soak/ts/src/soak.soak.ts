import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { digestDiffs, duplicatesClaim, erasureClaim, evaluate, restoreClaim, type Claim } from "./claims";
import { cloudRestore } from "./restore";
import { runDay } from "./day";
import { Clock, SoakNet, loadFixture } from "./net";
import { Svc, psql } from "./svc";

const seed = Number(process.env.SOAK_SEED ?? "1");
const mode = (process.env.SOAK_MODE ?? "settle") as "settle" | "print";
const out = process.env.SOAK_OUT ?? `/tmp/hostry-soak/run-${seed}-${mode}`;

describe(`trading-day soak, seed ${seed}, number_at=${mode}`, () => {
  it("runs the day, reconnects, and checks claims T1 to T13", async () => {
    const fx = loadFixture();
    const onboard = JSON.parse(readFileSync(process.env.SOAK_ONBOARD ?? "", "utf8")) as { owner_mobile: string };
    // The virtual trading day starts NOW (wall clock) and runs forward from there. The real gateway stamps cloud-origin ops with its own
    // clock, and a device holds a last-writer-wins op stamped more than MAX_FUTURE_MS ahead of its clock in clock quarantine (S5): with the
    // devices a day behind, the outlet's tax profile and numbering settings never applied. The day (up to ~9 virtual hours) must stay
    // inside one IST business day (cutoff 05:00), so the harness refuses to start outside 06:00 to 19:30 IST.
    const d0 = new Date(Date.now() - 10_000);
    const istHour = (d0.getUTCHours() + 5.5 + d0.getUTCMinutes() / 60) % 24;
    if (istHour < 6 || istHour > 19.5) throw new Error(`the soak starts at wall-clock time; run it between 06:00 and 19:30 IST (now ${istHour.toFixed(1)} IST)`);
    const clock = new Clock(d0.getTime());
    const date = new Date(d0.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    // HARNESS ADDITION (finding F21): billing learns its organisations from tenancy's `tenancy.organisation.created` event, but api-specs lists
    // only identity as its subscriber, so the bus account of billing cannot read it and `known_tenants` stays empty: the Z revision sweep
    // (SealRevisions) never runs for any organisation. The organisation is registered the way RecordOrganisation would, by SQL on billing's
    // own table. SOAK_NO_KNOWN_TENANT=1 runs without it.
    if (!process.env.SOAK_NO_KNOWN_TENANT) psql("billing", `insert into known_tenants (tenant_id, added_at) values ('${fx.tenant_id}', now()) on conflict do nothing`);
    const net = await SoakNet.create(fx, clock);
    const svc = new Svc({ billing: process.env.SOAK_BILLING_URL!, orders: process.env.SOAK_ORDERS_URL!, outlet: fx.outlet_id, mobile: onboard.owner_mobile });
    const t0 = Date.now();
    const facts = await runDay(net, { seed, mode, tables: Number(process.env.SOAK_TABLES ?? "10"), counterSales: Number(process.env.SOAK_SALES ?? "20"), restoreEpoch: process.env.SOAK_EPOCH === "1", clock });
    const dayWall = Date.now() - t0;

    // Reconnect: the internet returns and the isolated device and the partitioned counters rejoin.
    for (const d of net.devs.values()) d.lan.up = true;
    await net.setInternet(true);
    const r0 = Date.now();
    const rounds = await net.settle(120);
    const convergedWallMs = Date.now() - r0;

    // Billing seals a Z revision after the late batch has been quiet for its window, then emits it through the gateway:
    // wait for it (bounded), then let the devices pull it.
    await svc.login();
    const revDeadline = Date.now() + 120_000;
    let revCount = 0;
    while (Date.now() < revDeadline) {
      const days = await svc.all("billing", "/v1/business-days");
      revCount = days.find((x: any) => x.business_date === date)?.revision_count ?? 0;
      if (revCount >= 1) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    await new Promise((r) => setTimeout(r, 4000)); // the emit worker drains after the seal
    const rounds2 = await net.settle(120);

    let digestPre: { orders: string[]; billing: string[] } | undefined;
    let restore: Record<string, unknown> | undefined;
    if (facts.restoreEpoch) {
      await new Promise((r) => setTimeout(r, 8000)); // the consumers finish what the bus holds
      digestPre = await digestDiffs(net, svc, date);
      restore = await cloudRestore(net, fx.tenant_id, seed);
      await new Promise((r) => setTimeout(r, 8000)); // the re-offered ops reach the services again
    }
    const inputs = { net, facts, svc, date, tenant: fx.tenant_id, outlet: fx.outlet_id, convergedRounds: rounds, convergedWallMs, digestPre, restore };
    const { claims, extra } = await evaluate(inputs);
    claims.push(await duplicatesClaim(inputs));
    claims.push(await restoreClaim(inputs));
    claims.push(await erasureClaim(inputs));
    const gwOps = psql("sync", `select origin like 'cloud%', status, coalesce(reason,''), count(*) from ops where tenant_id='${fx.tenant_id}' group by 1,2,3 order by 1,2,3`);
    const parked = (db: string) => psql(db, "select count(*) from event_parked")[0]?.[0];
    const result = {
      seed, mode, date, tenant_id: fx.tenant_id, outlet_id: fx.outlet_id, wall_ms: Date.now() - t0, day_wall_ms: dayWall, reconnect_rounds: rounds, reconnect_wall_ms: convergedWallMs, post_revision_rounds: rounds2, revision_count_seen: revCount,
      claims, gateway_ops: gwOps.map(([c, s, r, n]) => ({ cloud_origin: c === "t", status: s, reason: r, n: Number(n) })), parked: { billing: parked("billing"), orders: parked("orders") },
      facts: { steps_failed: facts.steps.filter((s) => !s.ok), steps_total: facts.steps.length, events: facts.events, z: facts.z, z2: facts.z2, hubKills: facts.hubKills, hubWipes: facts.hubWipes, restarts: facts.restarts, lostAcks: facts.lostAcks, bills_by_device: facts.billsMadeBy, approvals: facts.approvals, config: facts.config, kot_latency_ms: facts.kotLatencyMs, blackout: facts.blackout, late_bill: facts.lateBill, wrong_tax: facts.wrongTax },
      extra: { ...extra, restore, digest_pre_restore: digestPre },
    };
    writeFileSync(`${out}.result.json`, JSON.stringify(result, null, 1));
    const line = (c: Claim) => `${c.id} ${c.name}: ${c.status.toUpperCase()}${c.failures.length ? ` (${c.failures.length} failing: ${c.failures[0]!.slice(0, 160)})` : ""}`;
    console.log("CLAIMS\n" + claims.map(line).join("\n"));
    expect(claims.length).toBeGreaterThan(10); // the run produced a verdict; pass or fail is in the claims, never hidden in the runner
  });
});
