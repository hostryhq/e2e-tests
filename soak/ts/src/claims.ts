import { serviceToken } from "./config";
import { detect, seriesGaps, type BillRow, type CreditNoteRow } from "@hostry/client-core";
import { compareDigests, deviceDigest } from "./digest";
import type { Facts } from "./day";
import { printModeVerdict } from "./scenarios";
import type { Dev, SoakNet } from "./net";
import { psql, type Svc } from "./svc";
import { FEATURE } from "../../../../app-restaurant/src/domain/entitlements";

export type Claim = { id: string; name: string; status: "pass" | "fail" | "not_run"; evidence: string[]; failures: string[] };

type R = Record<string, any>;
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** Version vectors are maps: equal when every origin has the same seq, whatever the key insertion order (run 2 compared the JSON text, which orders keys by arrival). */
const vEq = (a: unknown, b: unknown): boolean => eq(Object.entries(a as Record<string, number>).sort(), Object.entries(b as Record<string, number>).sort());

export type Inputs = {
  net: SoakNet;
  facts: Facts;
  svc: Svc;
  date: string;
  tenant: string;
  outlet: string;
  convergedRounds: number;
  convergedWallMs: number;
  /** Per-service digest differences measured before the cloud rollback, when the run did one. */
  digestPre?: { orders: string[]; billing: string[] } | undefined;
  restore?: R | undefined;
  t10?: import("./t10").T10State | undefined;
};

export function mk(id: string, name: string): { c: Claim; ok(cond: boolean, pass: string, fail: string): void; note(s: string): void } {
  const c: Claim = { id, name, status: "pass", evidence: [], failures: [] };
  return {
    c,
    ok(cond, pass, fail) {
      if (cond) c.evidence.push(pass);
      else {
        c.failures.push(fail);
        c.status = "fail";
      }
    },
    note: (s) => void c.evidence.push(s),
  };
}

const rowsOf = async (d: Dev, e: string): Promise<R[]> => (await d.rt.engine.rows(e)) as R[];
/** The rows as the store holds them, with the `~c:<field>` commitment members the projection digest covers (engine.rows hides them); tombstoned rows left out. */
const digestRowsOf = async (d: Dev, e: string): Promise<R[]> => ((await d.rt.store.list(e)) as R[]).filter((r) => r.deleted !== true);
const text = (p: unknown): string => Buffer.from(p as Uint8Array).toString("latin1");

export async function evaluate(i: Inputs): Promise<{ claims: Claim[]; extra: R }> {
  const { net, facts: f, svc, date } = i;
  const devs = [...net.devs.values()];
  const by = (n: string): Dev => net.dev(n);
  const a07 = by("A07");
  const extra: R = {};

  // The seeded duplicate (S5) is a second bill under an existing number: it stays out of the generic totals, numbers and prints below and is judged by S5.
  const dupSecond = f.scn.dupNumber?.secondBillId;
  const dupNumber = f.scn.dupNumber?.number;
  const bills = ((await rowsOf(a07, "bill")) as unknown as BillRow[]).filter((b) => b.id !== dupSecond);
  const notes = (await rowsOf(a07, "credit_note")) as unknown as CreditNoteRow[];
  const pays = (await rowsOf(a07, "payment")).filter((p) => p.bill_id !== dupSecond);
  const refunds = await rowsOf(a07, "refund");

  // ---- services ----
  const sBills = await svc.all("billing", "/v1/bills");
  const sNotes = await svc.all("billing", "/v1/credit-notes");
  const sPays = await svc.all("billing", "/v1/payments");
  const sRefunds = await svc.all("billing", "/v1/refunds");
  const register = await svc.all("billing", "/v1/document-register");
  const gaps = await svc.all("billing", "/v1/document-register/gaps");
  const days = await svc.all("billing", "/v1/business-days");
  const bExc = await svc.all("billing", "/v1/exceptions");
  const oExc = await svc.all("orders", "/v1/exceptions");
  const day = days.find((d: R) => d.business_date === date);
  const revisions = day ? await svc.all("billing", `/v1/business-days/${day.id}/revisions`) : [];
  const summary = (await svc.get("billing", `/v1/reports/day-summary?business_date=${date}`)).json?.items?.[0] ?? {};
  const bDigest = (await svc.get("billing", `/v1/projection-digests?business_date=${date}`)).json;
  const oDigest = (await svc.get("orders", `/v1/projection-digests?business_date=${date}`)).json;
  extra.exceptions = { billing: bExc.map((e: R) => `${e.kind}/${e.severity}/${e.status}/${e.subject_kind}`), orders_counts: oExc.reduce((m: R, e: R) => ({ ...m, [`${e.kind}/${e.status}`]: (m[`${e.kind}/${e.status}`] ?? 0) + 1 }), {}) };
  extra.revisions = revisions;

  // ---- T1 convergence ----
  {
    const t = mk("T1", "Convergence");
    // ADR-0002 A1.2 / RB3: a device applies its own ops locally while the cloud holds some of them (quarantine); its peers then hold
    // placeholders, so the plain hash differs by design. While any op is held, convergence is judged on acceptedStateHash() (the state
    // without the device's own held ops); with nothing held, on the plain stateHash().
    const heldN = devs.map((d) => [d.fx.name, d.rt.engine.heldOps().length] as const);
    const heldTotal = heldN.reduce((n, h) => n + h[1], 0);
    const plain = await Promise.all(devs.map(async (d) => [d.fx.name, await d.rt.engine.stateHash()] as const));
    const accepted = await Promise.all(devs.map(async (d) => [d.fx.name, await d.rt.engine.acceptedStateHash()] as const));
    // ADR-0014 A3 (client-core 1e26251): the state hash covers a commitment per personal field, never a value, so it is equal on every node
    // whether or not it holds the values. Convergence is judged on the PLAIN hash of every non-kds device (with ops held, on the accepted hash).
    const nonKds = new Set(devs.filter((d) => d.fx.kind !== "kds").map((d) => d.fx.name));
    const hashes = (heldTotal > 0 ? accepted : plain).filter((h) => nonKds.has(h[0]));
    const uniq = new Set(hashes.map((h) => h[1]));
    const kdsEq = devs.filter((d) => d.fx.kind === "kds").map((d) => [d.fx.name, plain.find((p) => p[0] === d.fx.name)![1] === [...uniq][0]] as const);
    t.note(`kds plain hash equals the others': ${JSON.stringify(kdsEq)} (informative: the commitment-only hash is meant to be equal on a kds too)`);
    const which = heldTotal > 0 ? `acceptedStateHash (${heldTotal} ops held on ${heldN.filter((h) => h[1] > 0).map((h) => `${h[0]}:${h[1]}`).join(",")})` : "plain stateHash (no op held)";
    t.ok(uniq.size === 1, `${devs.length} devices hold one ${which} ${[...uniq][0]!.slice(0, 16)}…`, `${which} differ: ${JSON.stringify(hashes.map((h) => [h[0], h[1].slice(0, 8)]))}`);
    if (uniq.size > 1) {
      // Which entities differ between the odd device(s) and the majority: row ids and content, so the cause is in the report.
      const { createHash } = await import("node:crypto");
      const names = (await import("@hostry/client-core")).restaurantRegistry().names();
      const sig = async (d: Dev, e: string): Promise<string> => createHash("sha256").update(JSON.stringify(((await d.rt.engine.rows(e)) as R[]).map((r) => [r.id, r]).sort((a, b) => (a[0] < b[0] ? -1 : 1)))).digest("hex").slice(0, 8);
      const rowsOf = async (d: Dev, e: string): Promise<number> => ((await d.rt.engine.rows(e)) as R[]).length;
      const counts = new Map<string, number>();
      for (const h of hashes) counts.set(h[1], (counts.get(h[1]) ?? 0) + 1);
      const major = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
      const ref = devs.find((d) => hashes.find((h) => h[0] === d.fx.name)![1] === major)!;
      for (const d of devs) {
        if (hashes.find((h) => h[0] === d.fx.name)![1] === major) continue;
        const diff: string[] = [];
        for (const e of names) {
          const [a, b] = [await sig(d, e), await sig(ref, e)];
          if (a !== b) {
            const [ra, rb] = [new Map(((await d.rt.engine.rows(e)) as R[]).map((r) => [r.id, r])), new Map(((await ref.rt.engine.rows(e)) as R[]).map((r) => [r.id, r]))];
            const fields = new Set<string>();
            for (const [id, x] of ra) {
              const y = rb.get(id);
              if (!y) fields.add("(row missing on ref)");
              else for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) fields.add(k);
            }
            diff.push(`${e} (${await rowsOf(d, e)} rows vs ${await rowsOf(ref, e)} on ${ref.fx.name}; fields ${[...fields].join(",")})`);
          }
        }
        t.note(`${d.fx.name} differs from ${ref.fx.name} in: ${diff.join(", ") || "no entity row (clock or hold bookkeeping only)"}`);
      }
    }
    if (uniq.size > 1) {
      // The same comparison with the values of personal fields (customer_*) left out of every row: is that all that differs?
      const { createHash } = await import("node:crypto");
      const names = (await import("@hostry/client-core")).restaurantRegistry().names();
      const neutral = await Promise.all(
        devs.map(async (d) => {
          const h = createHash("sha256");
          for (const e of names) {
            const rows = ((await d.rt.engine.rows(e)) as R[]).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith("customer_")))).sort((a, b) => (a.id < b.id ? -1 : 1));
            h.update(e + JSON.stringify(rows));
          }
          return [d.fx.name, h.digest("hex").slice(0, 8)] as const;
        }),
      );
      t.note(`rows compared with the customer_* values left out: ${new Set(neutral.map((n) => n[1])).size === 1 ? "all devices equal" : "still differ: " + JSON.stringify(neutral)}`);
    }
    t.note(`plain stateHash groups: ${new Set(plain.map((h) => h[1])).size}; accepted groups: ${new Set(accepted.map((h) => h[1])).size}; held per device ${JSON.stringify(heldN)}`);
    const vecs = await Promise.all(devs.map((d) => d.rt.engine.vector()));
    {
      // The "version vectors differ" note of run 2, isolated: which origins differ, between which devices, by how many ops.
      const names = devs.map((d) => d.fx.name);
      const origins = new Set(vecs.flatMap((v) => Object.keys(v as R)));
      const differing: string[] = [];
      for (const o of [...origins].sort()) {
        const per = vecs.map((v) => (v as R)[o] ?? 0);
        if (new Set(per).size > 1) differing.push(`${o}: ${per.map((n, k) => `${names[k]}=${n}`).join(" ")}`);
      }
      if (differing.length) t.note(`version-vector keys that differ (origin: per device): ${differing.join(" | ")}`);
    }
    t.note(`vector key order differs between devices (JSON text): ${!vecs.every((v) => eq(v, vecs[0]))}`);
    t.ok(vecs.every((v) => vEq(v, vecs[0])), "every device holds the same version vector (origin to seq, order-independent)", "version vectors differ between devices");
    {
      // PII placement (ADR-0014 A3.1): the customer's details of the script's sale are held by pos, waiter and the hub, never by a kds.
      const e = f.erasure;
      if (e) {
        const holds = async (d: Dev): Promise<boolean> => {
          const rs = [...(await rowsOf(d, "bill")), ...(await rowsOf(d, "check"))].filter((r) => r.customer_name === e.name || r.customer_gstin === e.gstin);
          return rs.length > 0;
        };
        const placed = await Promise.all(devs.map(async (d) => [d.fx.name, d.fx.kind, await holds(d)] as const));
        const bad = placed.filter((p) => (p[1] === "kds" ? p[2] : !p[2]));
        t.ok(bad.length === 0, `pii placement: ${placed.map((p) => `${p[0]}(${p[1]})=${p[2] ? "values" : "none"}`).join(" ")}`, `pii placed wrongly: ${bad.map((p) => `${p[0]}(${p[1]}) ${p[2] ? "holds values" : "holds none"}`).join(", ")}`);
        const hub = (await (await fetch(`${net.fx.ctl_url}/soak/hub/pii?needle=${encodeURIComponent(e.name)}`)).json()) as { rows: number; with_needle: number };
        t.ok(hub.with_needle > 0, `the hub holds the customer's name (${hub.with_needle} of ${hub.rows} op_pii rows)`, `the hub holds no op_pii row with the customer's name (${hub.rows} rows)`);
      }
    }
    const cloud = await a07.cloudT.hello({ protocol: 1 }).catch((e) => ({ vector: {}, err: String(e) }));
    const cv: Record<string, number> = {};
    for (const [k, v] of Object.entries((cloud as R).vector ?? {})) if (k.endsWith(`/outlet:${i.outlet}`)) cv[k.split("/")[0]!] = v as number;
    const dv = vecs[0] as Record<string, number>;
    t.ok(eq(Object.fromEntries(Object.entries(cv).sort()), Object.fromEntries(Object.entries(dv).filter(([k]) => !k.startsWith("cloud-")).sort())) || Object.keys(cv).filter((k) => !k.startsWith("cloud")).every((k) => cv[k] === dv[k]), "the cloud's outlet vector equals the devices' (origins compared)", `cloud vector ${JSON.stringify(cv)} != device ${JSON.stringify(dv)}`);
    t.ok(i.convergedRounds <= 12, `converged in ${i.convergedRounds} rounds of 5 s virtual time (${i.convergedWallMs} ms wall) after the internet returned: within 60 s`, `needed ${i.convergedRounds} rounds (> 12 = 60 s virtual)`);
    t.note("scope: the nodes compared are the 8 headless devices (device state hash), the hub and cloud by vector; the real entity registry (client-core restaurantRegistry) is in use");
    extra.stateHash = [...uniq][0];
    var t1 = t.c;
  }

  // ---- T2 money ----
  {
    const t = mk("T2", "Money");
    const total = (xs: R[], k: string) => sum(xs.map((x) => Number(x[k] ?? 0)));
    const devTotal = sum(bills.map((b) => b.total_paise));
    const z = f.z;
    t.ok(!!z, `device Z-report printed offline: ${z?.zNumber} total ${z?.totalPaise} paise over ${z?.billCount} bills`, "no offline Z-report was produced");
    const close = day?.close?.totals;
    if (z && close) {
      t.ok(close.total.amount_paise === z.totalPaise, `billing close total (${close.total.amount_paise}) equals the device Z total`, `billing close total ${close.total.amount_paise} != device Z total ${z.totalPaise}`);
      t.ok(close.bill_count === z.billCount, `billing close bill_count ${close.bill_count} equals the device Z bill count`, `billing close bill_count ${close.bill_count} != Z ${z.billCount}`);
    } else t.ok(false, "", "billing has no closed business day with totals for the date");
    t.ok(sBills.length === bills.length, `billing holds ${sBills.length} bills = device ${bills.length}`, `billing holds ${sBills.length} bills, device ${bills.length}`);
    const sTotal = sum(sBills.map((b: R) => b.total.amount_paise));
    t.ok(sTotal === devTotal, `bill totals equal to the paisa: ${devTotal}`, `bill total device ${devTotal} vs billing ${sTotal}`);
    const tenders = (rows: Array<{ tender: string; amt: number }>) => rows.reduce((m: R, r) => ({ ...m, [r.tender]: (m[r.tender] ?? 0) + r.amt }), {});
    const dT = tenders(pays.map((p) => ({ tender: p.tender, amt: Number(p.amount_paise) })));
    const sT = tenders(sPays.map((p: R) => ({ tender: p.tender, amt: p.amount.amount_paise })));
    t.ok(eq(Object.fromEntries(Object.entries(dT).sort()), Object.fromEntries(Object.entries(sT).sort())), `payment totals per tender equal: ${JSON.stringify(dT)}`, `tender totals device ${JSON.stringify(dT)} vs billing ${JSON.stringify(sT)}`);
    t.ok(refunds.length === sRefunds.length && sum(refunds.map((r) => Number(r.amount_paise))) === sum(sRefunds.map((r: R) => r.amount.amount_paise)), `refunds equal (${refunds.length})`, `refunds device ${refunds.length} vs billing ${sRefunds.length}`);
    t.ok(notes.length === sNotes.length && sum(notes.map((n) => n.total_paise)) === sum(sNotes.map((n: R) => n.total?.amount_paise ?? n.amount?.amount_paise ?? 0)), `credit notes equal (${notes.length})`, `credit notes device ${notes.length}/${sum(notes.map((n) => n.total_paise))} vs billing ${sNotes.length}/${sum(sNotes.map((n: R) => n.total?.amount_paise ?? n.amount?.amount_paise ?? 0))}`);
    const comp: Array<[string, number, number | undefined]> = [
      ["cgst", total(bills as unknown as R[], "cgst_paise"), summary.totals?.cgst?.amount_paise],
      ["sgst", total(bills as unknown as R[], "sgst_paise"), summary.totals?.sgst?.amount_paise],
      ["discounts", total(bills as unknown as R[], "discount_paise"), summary.totals?.discounts?.amount_paise],
      ["round_off", total(bills as unknown as R[], "round_off_paise"), summary.totals?.round_off?.amount_paise],
      ["bill_count", bills.length, summary.totals?.bill_count],
      ["total", devTotal, summary.totals?.total?.amount_paise],
    ];
    for (const [n, a, b] of comp) t.ok(a === b, `day summary ${n} = ${a}`, `day summary ${n}: device ${a} vs billing ${b}`);
    extra.t2 = { devTotal, z, billingClose: close?.total, summaryTotal: summary.totals?.total };
    var t2 = t.c;
  }

  // ---- T3 numbers ----
  {
    const t = mk("T3", "Numbers");
    for (const d of devs) {
      const g = (await seriesGaps(d.rt.store)).filter((x) => !dupNumber || !JSON.stringify(x).includes(dupNumber)); // the seeded duplicate is S5's
      t.ok(g.length === 0, `${d.fx.name}: no gap or duplicate in its series register`, `${d.fx.name}: ${JSON.stringify(g)}`);
    }
    const all = [...bills.map((b) => `bill:${b.number}`), ...notes.map((n) => `cn:${n.number}`)];
    t.ok(new Set(all).size === all.length, `${all.length} document numbers, all unique across the outlet`, "duplicate document numbers");
    const bySeries: Record<string, number[]> = {};
    for (const b of [...bills.map((x) => x.number), ...notes.map((x) => x.number)]) {
      const m = /^([A-Z0-9]+)\/(\d{4})\/(\d{6})$/.exec(b);
      if (m && !b.startsWith("MB")) (bySeries[`${m[1]}/${m[2]}`] ??= []).push(Number(m[3]));
    }
    for (const [k, v] of Object.entries(bySeries)) {
      const s = [...v].sort((a, b) => a - b);
      t.ok(s.every((n, j) => n === j + 1), `series ${k}: 1..${s.length} gapless`, `series ${k}: numbers ${s.join(",")}`);
    }
    const reg = Object.fromEntries(register.filter((r: R) => r.kind === "device").map((r: R) => [`${r.series_code}/${r.financial_year}`, { last: Number(String(r.last_number).split("/").pop()), count: r.count, gaps: r.gap_count }]));
    for (const [k, v] of Object.entries(bySeries)) {
      const r = (reg as R)[k];
      t.ok(!!r && r.last === Math.max(...v) && r.count === v.length && r.gaps === 0, `billing register ${k}: count ${v.length}, last ${Math.max(...v)}, gaps 0`, `billing register ${k}: ${JSON.stringify(r)} vs devices count ${v.length} last ${Math.max(...v)}`);
    }
    t.ok(gaps.length === 0, "billing reports no gap in the document register", `billing reports gaps: ${JSON.stringify(gaps).slice(0, 200)}`);
    const alerts = psql("sync", `select kind, detail from alerts where tenant_id='${i.tenant}' and kind ilike '%gap%'`);
    t.ok(alerts.length === 0, "no gap alert at the gateway", `gateway gap alerts: ${JSON.stringify(alerts)}`);
    const dc = await rowsOf(a07, "day_close");
    t.note(`device day_close rows on A07: ${dc.length} (z numbers ${dc.map((x) => x.z_number).join(", ")}); the contract has no series section on day_close, so the section-equals-register check is the register comparison above`);
    var t3 = t.c;
  }

  // ---- T4 tax ----
  {
    const t = mk("T4", "Tax");
    const st = (x: R) => x.verification?.status ?? "none";
    const cnt = (xs: R[]) => xs.reduce((m: R, x) => ({ ...m, [st(x)]: (m[st(x)] ?? 0) + 1 }), {});
    const bc = cnt(sBills);
    const nc = cnt(sNotes);
    extra.verification = { bills: bc, credit_notes: nc };
    const wrong = f.wrongTax ? sBills.find((b: R) => b.id === f.wrongTax!.billId) : undefined;
    // A typed paper-book entry (bill.manual_entry, `book_total_paise` set) is recorded `manual_entry` by design (api-specs billing: "verified, mismatch,
    // stale_rules, profile_mismatch or manual_entry"; svc-billing lists it as a warning, within round-off): it is not recomputed, so it is not "verified".
    const typed = new Set((bills as unknown as R[]).filter((b) => b.book_total_paise !== undefined && b.book_total_paise !== null).map((b) => b.id));
    const others = sBills.filter((b: R) => b.id !== f.wrongTax?.billId && !typed.has(b.id));
    t.ok(others.every((b: R) => st(b) === "verified"), `${others.length} bills verified by billing (all but the seeded one and ${typed.size} typed paper-book entr${typed.size === 1 ? "y" : "ies"})`, `bills not verified: ${JSON.stringify(cnt(others))}`);
    t.ok(sBills.filter((b: R) => typed.has(b.id)).every((b: R) => st(b) === "manual_entry"), `the ${typed.size} typed paper-book entr${typed.size === 1 ? "y is" : "ies are"} recorded manual_entry`, `typed entries not recorded manual_entry: ${JSON.stringify(cnt(sBills.filter((b: R) => typed.has(b.id))))}`);
    t.ok(sNotes.every((n: R) => st(n) === "verified"), `${sNotes.length} credit notes verified`, `credit notes: ${JSON.stringify(nc)}`);
    if (!f.wrongTax) t.ok(false, "", "the seeded wrong-tax bill was not made (script step failed)");
    else if (!wrong) t.ok(false, "", "the seeded wrong-tax bill is missing from billing: it was rejected");
    else {
      const dev = bills.find((b) => b.id === f.wrongTax!.billId);
      t.ok(st(wrong) !== "verified", `seeded wrong-tax bill ${f.wrongTax.number} is flagged: verification ${JSON.stringify(wrong.verification)}`, `seeded wrong-tax bill ${f.wrongTax.number} was verified`);
      t.ok(wrong.total.amount_paise === dev?.total_paise, "and billing kept it unchanged (total equals the device's)", `billing total ${wrong.total.amount_paise} != device ${dev?.total_paise}`);
    }
    const mism = bExc.filter((e: R) => e.kind === "tax_mismatch");
    t.note(`tax_mismatch exceptions in billing: ${mism.length}: ${mism.map((e: R) => `${e.subject_kind}:${e.subject_id.slice(0, 8)} diff=${e.params?.difference_paise}`).join("; ")}`);
    const unexplained = mism.filter((e: R) => e.subject_id !== f.wrongTax?.billId);
    t.ok(unexplained.length === 0, "every tax mismatch is the seeded one", `${unexplained.length} unexplained tax_mismatch exception(s): ${unexplained.map((e: R) => `${e.subject_kind} ${e.subject_id} difference ${e.params?.difference_paise}`).join("; ")}`);
    var t4 = t.c;
  }

  // ---- T5 kitchen ----
  {
    const t = mk("T5", "Kitchen");
    const pre = f.kitchenPre;
    if (!pre) t.ok(false, "", "kitchen audit was not taken");
    else {
      for (const [st2, a] of Object.entries(pre.byStation)) {
        t.ok(a.missing.length === 0, `${st2} screen held every one of its ${pre.kots} KOTs' tickets with the internet cut (none missing)`, `${st2}: ${a.missing.length} KOT(s) missing on the KDS`);
        t.ok(a.duplicateLines === 0, `${st2}: every KOT line exactly once`, `${st2}: ${a.duplicateLines} duplicated KOT line(s)`);
      }
    }
    const lat = [...f.kotLatencyMs].sort((a, b) => a - b);
    const p95 = lat.length ? lat[Math.min(lat.length - 1, Math.ceil(lat.length * 0.95) - 1)]! : NaN;
    t.ok(lat.length >= 10 && p95 <= 1000, `order to KDS on the LAN: ${lat.length} probes, p50 ${lat[Math.floor(lat.length / 2)]?.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms (≤ 1000 ms; each probe = push to hub + pull, driven back to back)`, `KOT latency p95 ${p95} ms over ${lat.length} probes`);
    // After everything converged: each KDS holds the ticket of every KOT of its station once, and the hub kills/wipe lost none.
    const kots = (await rowsOf(a07, "kot")) as Array<{ id: string; station_code: string }>;
    for (const [n, code] of [["K9K", "KITCHEN"], ["K8K", "BAR"]] as const) {
      const have = new Set((await rowsOf(by(n), "kot")).map((k) => k.id));
      const miss = kots.filter((k) => k.station_code === code && !have.has(k.id));
      t.ok(miss.length === 0, `${n} holds all ${kots.filter((k) => k.station_code === code).length} ${code} KOTs after ${f.hubKills} hub stops (one with a wiped disk)`, `${n} lacks ${miss.length} KOT(s) after the hub faults`);
    }
    var t5 = t.c;
  }

  // ---- T6 printing ----
  {
    const t = mk("T6", "Printing");
    const billPrints: string[] = [];
    const printers = [...devs, ...net.retired];
    for (const d of printers) for (const p of d.rt.fakes.bill.printed) billPrints.push(text(p));
    const dup = (s: string) => /duplicate/i.test(s);
    let wrong = 0;
    const per: R = {};
    for (const b of bills) {
      if ((b as R).source_kind === "manual_book") continue;
      // an original is a TAX INVOICE print of this number; credit notes and re-bills quote the number too
      const orig = billPrints.filter((s) => s.includes(b.number) && /TAX INVOICE/.test(s) && !/CREDIT NOTE|PRE-BILL/.test(s) && !dup(s)).length;
      per[b.number] = orig;
      if (orig !== (b.number === dupNumber ? 2 : 1)) wrong++; // the seeded duplicate number has two originals: two bills were printed under it
    }
    t.ok(wrong === 0, `each of ${Object.keys(per).length} bills has exactly one original print job`, `${wrong} bill(s) without exactly one original print: ${JSON.stringify(Object.entries(per).filter(([k, v]) => v !== (k === dupNumber ? 2 : 1)).slice(0, 6))}`);
    const reprintOk = billPrints.filter(dup).every((s) => /duplicate/i.test(s));
    t.ok(billPrints.some(dup) && reprintOk, `${billPrints.filter(dup).length} reprint(s) carry the duplicate banner`, "no marked reprint was found");
    const kotPrints: string[] = [];
    for (const d of printers) for (const p of d.rt.fakes.kitchen.printed) kotPrints.push(text(p.payload));
    const kots = (await rowsOf(a07, "kot")) as Array<{ id: string; kot_no: string; station_code: string }>;
    const stations = (await rowsOf(a07, "station")) as Array<{ code: string; output: string }>;
    const noOriginal = new Set([f.blackout.given, f.blackout.stale].filter(Boolean) as string[]);
    const printed = (k: { kot_no: string }) => kotPrints.filter((s) => new RegExp(`(?<![0-9A-Za-z])${String(k.kot_no).replace(/[^0-9A-Za-z]/g, ".")}(?![0-9A-Za-z])`).test(s) && !dup(s)).length;
    const wrongKot = kots.filter((k) => {
      const routed = /print|both/.test(stations.find((x) => x.code === k.station_code)?.output ?? "") && !noOriginal.has(k.id);
      return printed(k) !== (routed ? 1 : 0);
    });
    t.ok(wrongKot.length === 0, `${kots.length} KOTs: each printed once as an original on its routed printer (stations that only show on the KDS print none; the handed-over and the stale blackout ticket print none)`, `${wrongKot.length} of ${kots.length} KOTs not printed the expected number of times (e.g. ${wrongKot.slice(0, 3).map((k) => `${k.kot_no}/${k.station_code}=${printed(k)}`).join(", ")})`);
    t.note("scope: the fake printers capture the ESC/POS bytes of the bill printer and the kitchen printer per device; counts are of decoded text matches on the document number");
    extra.printing = { billPrints: billPrints.length, kotPrints: kotPrints.length };
    var t6 = t.c;
  }

  // ---- T7 nothing silent ----
  {
    const t = mk("T7", "Nothing silent");
    const viol = await Promise.all(devs.map(async (d) => [d.fx.name, await detect(d.rt.store)] as const));
    const kinds = (v: Array<{ kind: string; key: string }>) => v.map((x) => `${x.kind}:${x.key}`).sort();
    t.ok(viol.every((v) => eq(kinds(v[1]), kinds(viol[0]![1]))), `every node shows the same ${viol[0]![1].length} detector finding(s): ${kinds(viol[0]![1]).map((s) => s.slice(0, 28)).join(", ")}`, `detector findings differ between nodes: ${JSON.stringify(viol.map((v) => [v[0], kinds(v[1]).length]))}`);
    const over = viol[0]![1].filter((x) => x.kind === "overpayment" && x.key === f.doublePay?.billId);
    const afterRefund = f.doublePay ? sum(pays.filter((p) => p.bill_id === f.doublePay!.billId).map((p) => Number(p.amount_paise))) - sum(refunds.filter((r) => r.payment_id && pays.some((p) => p.id === r.payment_id && p.bill_id === f.doublePay!.billId)).map((r) => Number(r.amount_paise))) : 0;
    t.note(`seeded double payment: ${f.doublePay ? "made" : "NOT made"}; overpayment finding still open after the refund: ${over.length}; net paid after refund ${afterRefund}`);
    t.ok(!!f.doublePay, "the double payment was seeded", "the double payment could not be seeded (script step failed)");
    const raceKinds = bExc.filter((e: R) => ["line_on_two_bills", "two_bills_one_check"].includes(e.kind)).map((e: R) => e.kind);
    t.ok(!!f.race && raceKinds.includes("line_on_two_bills"), `line-on-two-bills race appears in billing exceptions: ${raceKinds.join(", ")}`, `no line_on_two_bills exception in billing (kinds: ${bExc.map((e: R) => e.kind).join(", ")})`);
    const dpKinds = bExc.filter((e: R) => /pay/i.test(e.kind)).map((e: R) => e.kind);
    t.ok(dpKinds.length > 0, `the double payment appears in billing exceptions: ${dpKinds.join(", ")}`, "the seeded double payment does not appear in billing exceptions (no payment-related exception kind)");
    t.ok(f.race ? notes.some((n) => n.bill_id === f.race!.checks[2]) : false, "the race is closed by a credit note op", "no credit note closes the second bill of the race");
    t.ok(f.doublePay ? refunds.some((r) => pays.some((p) => p.id === r.payment_id && p.bill_id === f.doublePay!.billId)) : false, "the double payment is closed by a refund op", "no refund op closes the double payment");
    const origin = Object.fromEntries(devs.map((d) => [d.fx.device_id, d]));
    const gw = psql("sync", `select origin, status, count(*) from ops where tenant_id='${i.tenant}' and status in ('quarantined','voided') group by 1,2`);
    const gwByOrigin: R = {};
    for (const [o, , n] of gw) gwByOrigin[o!] = (gwByOrigin[o!] ?? 0) + Number(n);
    const rows2 = devs.map((d) => ({ dev: d.fx.name, attention: d.rt.sync.status().attentionOps, gateway: gwByOrigin[d.fx.device_id] ?? 0 }));
    extra.attention = rows2;
    {
      // What the attention count is made of (held ops, refused ops, conflicts to confirm, chain conflicts, clock-held ops), per device.
      const parts = await Promise.all(devs.map(async (d) => ({ dev: d.fx.name, held: d.rt.engine.heldOps().length, refused: d.rt.engine.refusedOps().length, conflicts: ((await d.rt.engine.conflicts()) as R[]).map((c) => `${c.entity ?? c.e}.${c.field ?? c.f}`), clock_held: (await d.rt.engine.clockQuarantine()).map((o) => `${devs.find((x) => x.fx.device_id === o.origin)?.fx.name ?? o.origin.slice(-4)}/${o.seq}`) })));
      extra.attention_parts = parts;
      t.note(`attention made of: ${JSON.stringify(parts.slice(0, 2))} (same on every device: ${new Set(parts.map((p) => JSON.stringify([p.held, p.refused, p.conflicts, p.clock_held]))).size === 1})`);
    }
    const mismatch = rows2.filter((r) => r.attention !== r.gateway);
    t.ok(mismatch.length === 0, `ops shown as needing attention equal the quarantined or voided: ${rows2.filter((r) => r.gateway).map((r) => `${r.dev} ${r.attention}=${r.gateway}`).join(", ") || "none quarantined"}`, `attention vs gateway quarantined/voided per origin: ${JSON.stringify(mismatch)}`);
    void origin;
    var t7 = t.c;
  }

  // ---- T8 day close ----
  {
    const t = mk("T8", "Day close");
    t.ok(f.blockedCloseCode === "day_blocked", "day close was refused while an order line was unresolved (day_blocked)", `day close with an unresolved line answered ${f.blockedCloseCode}`);
    t.ok(!!f.z && !net.internet || !!f.z, `day close succeeded offline after resolution: ${f.z?.zNumber}`, "day close did not succeed");
    t.note(`orders exceptions around close: ${JSON.stringify(Object.entries(extra.exceptions.orders_counts).filter(([k]) => k.startsWith("unresolved")))}`);
    var t8 = t.c;
  }

  // ---- T9 projections ----
  {
    const t = mk("T9", "Projections");
    const entitiesOf = async (): Promise<Record<string, R[]>> => {
      const m: Record<string, R[]> = {};
      for (const e of Object.keys((await import("./entities.generated.json")).default as R)) m[e] = await digestRowsOf(a07, e);
      return m;
    };
    const rows = await entitiesOf();
    for (const [owner, svcDigest] of [["orders", oDigest], ["billing", bDigest]] as const) {
      if (!svcDigest?.entities) {
        t.ok(false, "", `${owner} returned no digest: ${JSON.stringify(svcDigest).slice(0, 160)}`);
        continue;
      }
      const texts = new Map<string, string>();
      const dev = deviceDigest(owner, date, rows, texts);
      const diff = compareDigests(dev, svcDigest);
      if (owner === "orders" && dev.state_hash !== svcDigest.state_hash) {
        // Diagnostic: the commitments the device holds for each `check` row, against what orders recorded for it.
        for (const [k, v] of texts) {
          if (!k.startsWith("check|") || !v.includes("~c:")) continue;
          const id = k.split("|")[1]!;
          const dj = JSON.parse(v) as R;
          const devC = Object.entries(dj).filter(([x]) => x.startsWith("~c:")).map(([x, c]) => `${x}=${String(c).slice(0, 10)}`);
          const rec = psql("orders", `select field, left(commitment,10), hlc, origin, seq, is_insert from pii_commitments where entity='check' and row_id='${id}' order by field, hlc`).map((r) => r.join("/"));
          const proj = psql("orders", `select coalesce((meta->'pii_c')::text, 'null') from projection_rows where entity='check' and id='${id}'`).map((r) => r[0]);
          t.note(`orders check ${id.slice(0, 8)}: device commitments [${devC.join(", ")}]; orders pii_commitments rows [${rec.join(" ; ")}]; projection pii_c ${JSON.stringify(proj)}`);
        }
      }
      if (owner === "billing" && dev.state_hash !== svcDigest.state_hash) {
        // Which rows differ, and how: the service's stored row texts against the device's (diagnostic only).
        const svcTexts = new Map(psql("billing", "select body#>>'{}' from docs where kind='digest_row'").map((r) => [r[0]!, true] as const));
        const only = [...texts.entries()].filter(([k, v]) => k.startsWith("bill|") && !svcTexts.has(v));
        for (const [k, v] of only.slice(0, 4)) {
          const id = k.split("|")[1]!;
          const sv = [...svcTexts.keys()].find((x) => x.includes(`"id":"${id}"`));
          const dj = JSON.parse(v) as R;
          const sj = sv ? (JSON.parse(sv) as R) : {};
          const keys = [...new Set([...Object.keys(dj), ...Object.keys(sj)])].filter((x) => JSON.stringify(dj[x]) !== JSON.stringify(sj[x]));
          t.note(`billing row ${k} differs in: ${keys.map((x) => `${x} device=${JSON.stringify(dj[x])} service=${JSON.stringify(sj[x])}`).join("; ")}`);
        }
        t.note(`${only.length} device bill row text(s) have no equal row text in billing`);
      }
      t.ok(dev.state_hash === svcDigest.state_hash, `${owner}: service state_hash equals the device's (${dev.state_hash.slice(0, 16)}…)`, `${owner}: state_hash differs; ${diff.length} entit${diff.length === 1 ? "y" : "ies"} differ: ${diff.join(" | ")}`);
      // Every other device computes the same digest (the per-service hash is a property of the converged state).
    }
    if (i.digestPre) {
      for (const owner of ["orders", "billing"] as const) {
        const pre = i.digestPre[owner];
        const same = (owner === "orders" ? oDigest : bDigest)?.state_hash;
        t.note(`before the cloud rollback, ${owner}: ${pre.length === 0 ? "equal to the device digest" : `${pre.length} entity difference(s): ${pre.join(" | ")}`}; after it the service state_hash is ${String(same).slice(0, 12)}…`);
      }
    } else t.note("the cloud rollback was not part of this run (seed without a restore epoch)");
    t.note("the bus reset was not run in any seed: no bus-reset tool exists in go-common or infra (the outbox documentation names hostry-bus-reset)");
    var t9 = t.c;
  }

  // ---- T10 ----
  const t10 = (() => {
    const t = mk("T10", "Trading is never gated");
    const st = i.t10;
    if (!st) {
      t.c.status = "not_run";
      t.c.failures.push("the run did not drive the entitlement scenario");
      return t.c;
    }
    if (st.error) t.ok(false, "", `the scenario did not complete: ${st.error}`);
    const names = [...net.devs.keys()];
    const first = names[0]!;
    const morning = names.map((n) => st.morning[n]);
    t.ok(morning.length > 0 && morning.every((m) => m && (m.v ?? 0) >= 1 && m.status === "active" && m.kds && m.captain),
      `all ${names.length} devices held the pack's snapshot from the morning (v ${[...new Set(morning.map((m) => m?.v))].join("/")}, plan ${morning[0]?.plan}, active, restaurant.kds and restaurant.captain granted)`,
      `a device lacked the morning snapshot: ${JSON.stringify(st.morning).slice(0, 300)}`);
    // Billing state never gates: overdue at the vendor the whole day, and every trading step of the day went through.
    t.ok(st.overdueAtOnboarding, "the subscription was overdue (a charge for a long-past period was open) for the whole trading day", "the subscription was not overdue: the billing-state half of the claim was not exercised");
    const failed = f.steps.filter((s) => !s.ok);
    t.ok(failed.length === 0 && f.steps.length > 50, `all ${f.steps.length} steps of the trading day succeeded on devices that held an overdue subscription and a kitchen-screen plan; ${Object.values(f.billsMadeBy).reduce((a, b) => a + b, 0)} bills made`, `${failed.length} of ${f.steps.length} steps failed: ${failed.slice(0, 2).map((s) => s.name + " " + s.error).join("; ")}`);
    // Plan change mid-day: the vendor side moved, the offline devices did not.
    const mid = st.mid;
    t.ok(!!mid && /^soak_lite /.test(mid.vendorChange), `mid-day, internet cut: the vendor changed the plan to one without restaurant.kds (${mid?.vendorChange}); the subscription was still overdue`, `the mid-day plan change did not happen (${mid?.vendorChange ?? "no record"})`);
    t.ok(!!mid && names.every((n) => eq(mid.heldWhileOffline[n], st.morning[n])), "while offline no device changed what it held (same version, features and status as the morning)", "a device changed its snapshot without a pack refresh");
    const rc = st.reconnect;
    if (!rc) t.ok(false, "", "the reconnect refresh did not run");
    else {
      const refreshed = names.every((n) => rc.refresh[n]?.fetched === 200 && rc.refresh[n]?.adopted === true && (rc.refresh[n]?.after.v ?? 0) > (rc.refresh[n]?.before.v ?? 99));
      t.ok(refreshed, `on the pack refresh every device adopted the higher snapshot (v${st.morning[first]?.v} to v${rc.refresh[first]?.after.v})`, `a device did not adopt the higher snapshot: ${JSON.stringify(Object.fromEntries(names.map((n) => [n, { f: rc.refresh[n]?.fetched, a: rc.refresh[n]?.adopted, v: rc.refresh[n]?.after.v }]))).slice(0, 400)}`);
      t.ok(names.every((n) => rc.refresh[n]?.after.kds === false && rc.refresh[n]?.after.captain === true && rc.refresh[n]?.after.status === "active"), "after adoption restaurant.kds is off and restaurant.captain stays on, on every device", "the adopted snapshot is not the lite plan's");
      t.ok(names.every((n) => rc.stale[n]?.adopted === false && rc.stale[n]?.v === rc.refresh[n]?.after.v), "an old pack (the morning's version) offered again does not lower the version", "a stale pack lowered or replaced the snapshot");
      t.ok(rc.malformedAdopted === false, "a malformed snapshot is ignored", "a malformed snapshot was adopted");
      const kitchens = ["K9K", "K8K"].map((n) => rc.offlineAfterAdopt[n]);
      t.ok(kitchens.every((k) => k && k.kds === false), "with the internet cut again both kitchen screens find restaurant.kds absent from the held snapshot: kitchen mode is unavailable offline for a plan without it", "a kitchen screen still offers kitchen mode on a plan without restaurant.kds");
    }
    const sd = st.standing;
    if (!sd) t.ok(false, "", "the standing check did not run");
    else {
      t.ok(sd.dayInProgress.startNew === true && sd.dayInProgress.ending === true, "synthetic status suspended, day in progress: trading goes on and the day is marked as the last (ADR-0014 A1.2)", "a suspended status stopped trading while a day was in progress");
      t.ok(sd.daysOpenAtEnd.length === 0 && sd.afterTheDay.startNew === false && sd.closedAfterTheDay.startNew === false, "synthetic status suspended or closed, the real day closed: no new trading starts after the day", `suspension did not apply after the day (open days ${sd.daysOpenAtEnd.join(",")}, suspended ${sd.afterTheDay.startNew}, closed ${sd.closedAfterTheDay.startNew})`);
      t.ok(sd.absentSnapshot.startNew === true, "no snapshot at all: trading continues", "an absent snapshot stopped trading");
    }
    t.note("suspension and closure statuses are synthetic: the vendor suspension needs an approval and is refused while a day is open (admin suspendOrganisation), so the status was set on the adopted snapshot and the app's own tradingStanding decided against the device's real day rows");
    return t.c;
  })();

  // ---- T11 business day ----
  {
    const t = mk("T11", "Business day");
    for (const d of devs) {
      const bd = (await rowsOf(d, "business_day")).filter((x) => x.business_date === date);
      t.ok(bd.length === 1, `${d.fx.name}: one business_day for ${date}`, `${d.fx.name}: ${bd.length} business_day rows for ${date}`);
    }
    const dcs = await rowsOf(a07, "day_close");
    const orig = dcs.find((x) => x.z_number === f.z?.zNumber);
    t.ok(!!orig && orig.total_paise === f.z?.totalPaise && orig.bill_count === f.z?.billCount, "the original Z totals on the device are unchanged after the late bills arrived", `original Z ${f.z?.zNumber} now ${JSON.stringify(orig ? { total: orig.total_paise, count: orig.bill_count } : null)} vs printed ${JSON.stringify(f.z)}`);
    const revs = await Promise.all(devs.map(async (d) => (await rowsOf(d, "business_day_revision")).map((r) => `${r.business_day_id}#${r.revision}`).sort()));
    t.ok(revs.every((r) => eq(r, revs[0])), `revision numbers equal on every node: ${JSON.stringify(revs[0])}`, `revision sets differ between nodes: ${JSON.stringify(revs.map((r) => r.length))}`);
    t.ok(revisions.length >= 1 && (revs[0]?.length ?? 0) === revisions.length, `billing holds ${revisions.length} Z revision(s), equal to the devices'`, `billing revisions ${revisions.length} vs device ${revs[0]?.length ?? 0}: the late bill after close (${f.lateBill?.number}) produced no Z revision at billing within the wait`);
    const late = bills.filter((b) => [f.lateBill?.number, f.wrongTax?.number].includes(b.number));
    const lateTotal = sum(late.map((b) => b.total_paise));
    const revTotal = sum(revisions.map((r: R) => r.added_totals?.total?.amount_paise ?? r.totals?.total?.amount_paise ?? r.delta?.total?.amount_paise ?? 0));
    t.ok(!!f.z && f.z.totalPaise + revTotal === sum(bills.map((b) => b.total_paise)), `original Z plus revisions equals all bills (${sum(bills.map((b) => b.total_paise))})`, `original Z ${f.z?.totalPaise} + revisions ${revTotal} != all bills ${sum(bills.map((b) => b.total_paise))} (late bills on A09 total ${lateTotal})`);
    t.note(`A08 closed the same date while partitioned from A07: Z numbers ${f.z?.zNumber} and ${f.z2?.zNumber}; billing day status ${day?.status}, late_document_count ${day?.late_document_count}, revision_count ${day?.revision_count}`);
    var t11 = t.c;
  }

  // ---- T12 numbering trigger ----
  {
    const t = mk("T12", "Numbering trigger");
    const presents = await rowsOf(a07, "check_present");
    const checks = (await rowsOf(a07, "check")) as Array<{ id: string; status: string }>;
    const billedChecks = new Set(bills.map((b) => (b as R).check_id).filter(Boolean));
    const cancels = new Set((await rowsOf(a07, "check_cancel")).map((c) => c.check_id));
    const presented = [...new Set(presents.map((p) => p.check_id))];
    if (f.mode === "settle") {
      const own = bills.filter((b) => !((b as R).source_kind === "manual_book"));
      t.ok(presented.length > 0, `${presented.length} check(s) were presented (pre-bill) during the day`, "no check was presented, the claim is not exercised");
      const nums = bills.filter((b) => (b as R).source_kind !== "manual_book").length + notes.length;
      const used = register.filter((r: R) => r.kind === "device").reduce((n: number, r: R) => n + r.count, 0);
      t.ok(used === nums, `numbers consumed (${used}) equal documents that exist (${nums}): presenting consumed none`, `numbers consumed ${used} != documents ${nums}`);
      const unresolved = presented.filter((c) => !billedChecks.has(c) && !cancels.has(c) && checks.find((x) => x.id === c)?.status === "open");
      t.ok(unresolved.length === 0, "every presented check ended billed, cancelled with approval or carried over", `${unresolved.length} presented check(s) neither billed nor cancelled`);
    } else {
      // In an outlet set to print the first Present IS the finalisation (ADR-0014 A1.5): it records no pre-bill (`check_present`) at all and issues
      // the numbered invoice, so the evidence is that no pre-bill row exists while invoices do, that the numbers consumed equal the documents, and
      // that every check the script presented ended billed.
      const own = bills.filter((b) => (b as R).source_kind !== "manual_book");
      const nums = own.length + notes.length;
      const used = register.filter((r: R) => r.kind === "device").reduce((n: number, r: R) => n + r.count, 0);
      t.ok(own.length > 0 && presents.length === 0, `print mode: ${own.length} invoices were issued and no pre-bill row exists (Present finalised, it never recorded an unnumbered pre-bill)`, `print mode: ${presents.length} pre-bill row(s) exist beside ${own.length} invoices`);
      t.ok(used === nums, `numbers consumed (${used}) equal documents that exist (${nums})`, `numbers consumed ${used} != documents ${nums}`);
      const openChecks = checks.filter((x) => x.status === "open" && !billedChecks.has(x.id) && !cancels.has(x.id));
      t.ok(openChecks.length === 0, "no check is left open without a bill or a cancellation", `${openChecks.length} open check(s) without a bill`);
      // M5 (code review): the lines above also hold when the script never pressed Present. This is the evidence that can fail for the reason it names.
      const pm = printModeVerdict(f.scn, own as unknown as Array<{ id: string; number: string; check_id?: string }>);
      for (const p of pm.pass) t.ok(true, p, "");
      for (const x of pm.fail) t.ok(false, "", x);
    }
    var t12 = t.c;
  }

  // ---- T13 blackout ----
  {
    const t = mk("T13", "Blackout");
    const kitchen = by("K9K");
    const late = kitchen.rt.fakes.hub.lateTickets().map((x) => x.reason).sort();
    t.ok(eq(late, ["handover", "stale"]), `the KDS station lists the ticket handed over by hand and the stale one as late tickets: ${JSON.stringify(late)}`, `late tickets on the station: ${JSON.stringify(late)} (expected handover and stale)`);
    const kp = kitchen.rt.fakes.kitchen.printed.map((p) => text(p.payload));
    const recentNo = ((await rowsOf(a07, "kot")) as R[]).find((k) => k.id === f.blackout.recent)?.kot_no;
    t.ok(recentNo ? kp.filter((s) => s.includes(String(recentNo)) && !/duplicate/i.test(s)).length === 1 : false, "the recent blackout ticket printed once on the station", "the recent blackout ticket did not print exactly once");
    const givenNo = ((await rowsOf(a07, "kot")) as R[]).find((k) => k.id === f.blackout.given)?.kot_no;
    const staleNo = ((await rowsOf(a07, "kot")) as R[]).find((k) => k.id === f.blackout.stale)?.kot_no;
    t.ok(![givenNo, staleNo].some((n) => n && kp.some((s) => s.includes(String(n)) && !/duplicate/i.test(s))), "no handed-over and no stale KOT printed as an original after power returned", "a handed-over or stale KOT printed as an original");
    const blackoutBills = bills.filter((b) => b.number.startsWith(by("A08").fx.series?.find((s) => s.doc_type === "tax_invoice")?.code ?? "~")).length;
    t.ok(blackoutBills > 0, `bills finalised on the battery counter in the blackout keep their series (${by("A08").fx.series?.find((s) => s.doc_type === "tax_invoice")?.code}: gapless per T3) and their original print exists (T6)`, "no bill was finalised in the blackout");
    t.ok((f.blackout.settleRounds ?? 99) <= 12, `nodes converged ${f.blackout.settleRounds} rounds (5 s virtual each, ${f.blackout.settleWallMs} ms wall) after the LAN returned: within 60 s`, `convergence after the power returned took ${f.blackout.settleRounds} rounds`);
    const manual = bills.filter((b) => b.number === f.blackout.bookNumber);
    t.ok(f.blackout.bookEntriesMade === 2 && manual.length === 1, `the paper page typed twice (${f.blackout.bookEntriesMade} entries) is ${manual.length} bill: ${f.blackout.bookNumber}`, `the page typed ${f.blackout.bookEntriesMade} times produced ${manual.length} bill row(s)`);
    t.ok((await rowsOf(kitchen, "kot_handover")).length >= 1, "the handover is recorded and listed on the KDS side", "no kot_handover row reached the KDS");
    var t13 = t.c;
  }

  const claims = [t1!, t2!, t3!, t4!, t5!, t6!, t7!, t8!, t9!, t10, t11!, t12!, t13!];
  return { claims, extra };
}

/** Extra claim: no op is stored or applied twice after lost acknowledgements, hub restarts and a wiped hub disk. */
export async function duplicatesClaim(i: Inputs): Promise<Claim> {
  const t = mk("X1", "No duplicate ops after lost acks");
  const devs = [...i.net.devs.values()];
  const rows = psql("sync", `select origin, count(*), max(seq), min(seq) from ops where tenant_id='${i.tenant}' and stream='outlet:${i.outlet}' and origin not like 'cloud%' group by 1`);
  const gw = Object.fromEntries(rows.map((r) => [r[0]!, { n: Number(r[1]), max: Number(r[2]), min: Number(r[3]) }]));
  for (const d of devs) {
    const vec = (await d.rt.engine.vector()) as Record<string, number>;
    const own = vec[d.fx.device_id] ?? 0;
    const g = gw[d.fx.device_id];
    t.ok(own === 0 ? !g : !!g && g.n === own && g.max === own && g.min === 1, `${d.fx.name}: ${own} own ops, gateway stores ${g?.n ?? 0}, contiguous from 1`, `${d.fx.name}: device recorded ${own} ops, gateway stores ${g?.n ?? 0} (max seq ${g?.max})`);
  }
  t.note(`${i.facts.lostAcks} push answer(s) were lost after the server applied them; ${i.facts.hubKills} hub stop(s) incl. ${i.facts.hubWipes} disk wipe; ${i.facts.restarts.length} device restart(s)`);
  const gwOutbox = psql("sync", `select count(*), count(distinct id) from outbox where tenant_id='${i.tenant}'`)[0]!;
  t.ok(gwOutbox[0] === gwOutbox[1], `${gwOutbox[0]} outbox events, all distinct ids`, "duplicate outbox event ids");
  return t.c;
}

/** Extra claim: erasure of a customer's details removes them from every service's projection, the gateway and the devices. */
export async function erasureClaim(i: Inputs): Promise<Claim> {
  const t = mk("X2", "Erasure of a customer's details");
  const e = i.facts.erasure;
  if (!e) {
    t.ok(false, "", "the sale with customer details was not made");
    return t.c;
  }
  const { net, svc } = i;
  const a07 = net.dev("A07");
  const seen = async (): Promise<{ billing: boolean; orders: boolean }> => {
    const b = JSON.stringify((await svc.get("billing", `/v1/bills/${e.billId}`)).json);
    const o = JSON.stringify((await svc.get("orders", `/v1/checks/${e.checkId}`)).json);
    const hit = (s: string) => s.includes(e.name) || s.includes(e.gstin);
    return { billing: hit(b), orders: hit(o) };
  };
  const before = await seen();
  const where = async (d: Dev): Promise<string[]> => {
    const out: string[] = [];
    for (const ent of ["check", "bill", "order"]) for (const r of (await d.rt.engine.rows(ent)) as R[]) for (const [k, v] of Object.entries(r)) if (typeof v === "string" && (v.includes(e.name) || v.includes(e.gstin))) out.push(`${ent}.${k}`);
    return [...new Set(out)];
  };
  const devHas = async (d: Dev): Promise<boolean> => (await where(d)).length > 0;
  const devBefore = await devHas(a07);
  const opPiiBefore = psql("sync", `select count(*) from op_pii where tenant_id='${i.tenant}'`)[0]![0];
  const refSql = e.refs.map((r) => `(origin='${r.origin}' and seq=${r.seq})`).join(" or ");
  const sidePii = (db: string) => psql(db, `select count(*) from sync_pii where tenant_id='${i.tenant}' and (${refSql}) and (fields::text like '%${e.name}%' or fields::text like '%${e.gstin}%')`)[0]![0];
  const sideBefore = { billing: sidePii("billing"), orders: sidePii("orders") };
  t.note(`erasable side tables (sync_pii) holding the values before: billing ${sideBefore.billing}, orders ${sideBefore.orders}`);
  t.note(`before erasure: details present in billing ${before.billing}, orders ${before.orders}, device A07 ${devBefore}, gateway op_pii rows ${opPiiBefore}`);
  t.ok(before.billing || before.orders || devBefore, "customer details were present somewhere before the erasure (the test is meaningful)", "no service or device held the customer's details before the erasure: nothing to erase");
  const res = [];
  {
    // POST /internal/v1/pii/erase as billing (the route svc-sync now has; one request names every target).
    // The caller names every op that carries the values: the owners of the side tables know them (billing and orders keep sync_pii with the
    // op reference), so the targets are the union of what the script recorded and what those tables hold for the customer.
    const have = new Set(e.refs.map((r) => `${r.origin}|${r.stream}|${r.seq}`));
    for (const db of ["billing", "orders"]) {
      for (const [o, st, sq] of psql(db, `select origin, stream, seq from sync_pii where tenant_id='${i.tenant}' and (fields::text like '%${e.name}%' or fields::text like '%${e.gstin}%')`)) {
        if (!have.has(`${o}|${st}|${sq}`)) {
          have.add(`${o}|${st}|${sq}`);
          e.refs.push({ intent: `(from ${db} sync_pii)`, origin: o!, stream: st!, seq: Number(sq) });
        }
      }
    }
    const tok = await serviceToken("billing", "sync", i.tenant);
    const r = await fetch(`${net.fx.cloud_url}/internal/v1/pii/erase`, { method: "POST", headers: { "content-type": "application/json", "Hostry-Service-Token": tok, "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ targets: e.refs.map(({ origin, stream, seq }) => ({ origin, stream, seq })) }) });
    res.push({ status: r.status, body: await r.text() });
  }
  t.ok(res.every((r) => r.status === 200), `gateway erasure issued for ${res.length} op(s) (POST /internal/v1/pii/erase as billing)`, `erase refused: ${JSON.stringify(res.map((r) => [r.status, r.body.slice(0, 80)]))}`);
  // The erasure is a cloud-signed op and an event: devices pull it, services apply the event.
  const deadline = Date.now() + 90_000;
  let after = await seen();
  while ((after.billing || after.orders) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    after = await seen();
  }
  await net.settle(60);
  t.ok(!after.billing, "billing no longer returns the name or GSTIN", "billing still returns the customer's details after the erasure");
  t.ok(!after.orders, "orders no longer returns the name or GSTIN", "orders still returns the customer's details after the erasure");
  const stillOnDevices: string[] = [];
  for (const d of net.devs.values()) if (await devHas(d)) stillOnDevices.push(d.fx.name);
  t.ok(stillOnDevices.length === 0, "no device holds the details any more", `devices still holding the details: ${stillOnDevices.join(", ")} (fields: ${(await where(a07)).join(", ")})`);
  const sideAfter = { billing: sidePii("billing"), orders: sidePii("orders") };
  t.ok(sideAfter.billing === "0" && sideAfter.orders === "0", `billing and orders side tables no longer hold the values (${sideBefore.billing}/${sideBefore.orders} before, 0/0 after)`, `side tables still hold the values after the erasure: billing ${sideAfter.billing}, orders ${sideAfter.orders}`);
  const erasedRecs = (await net.dev("A07").rt.engine.rows("pii_erase").catch(() => [])).length;
  t.note(`device A07 holds ${erasedRecs} pii_erase record(s); ${await net.dev("A07").rt.engine.vector().then((v) => JSON.stringify(Object.keys(v).filter((k) => k.startsWith("cloud"))))} cloud origins in its vector`);
  const opPiiAfter = psql("sync", `select count(*) from op_pii where tenant_id='${i.tenant}' and origin='${e.refs[0]?.origin}' and seq in (${e.refs.map((r) => r.seq).join(",")})`)[0]![0];
  t.ok(opPiiAfter === "0", "the gateway's op_pii rows of those ops are gone", `gateway still holds ${opPiiAfter} op_pii row(s) of the erased ops`);
  t.note("the copy on the internal queue ages out within 7 days (ADR-0014 A2.1 item 7): not waited for, stated in the erasure promise");
  return t.c;
}

/** Entity-level differences between a device's digest and each service's, for one business date (used before and after a rollback). */
export async function digestDiffs(net: SoakNet, svc: Svc, date: string): Promise<{ orders: string[]; billing: string[] }> {
  const a07 = net.dev("A07");
  const rows: Record<string, R[]> = {};
  for (const e of Object.keys((await import("./entities.generated.json")).default as R)) rows[e] = await digestRowsOf(a07, e);
  const out = { orders: [] as string[], billing: [] as string[] };
  for (const owner of ["orders", "billing"] as const) {
    const sd = (await svc.get(owner, `/v1/projection-digests?business_date=${date}`)).json;
    out[owner] = sd?.entities ? compareDigests(deviceDigest(owner, date, rows), sd) : [`no digest: ${JSON.stringify(sd).slice(0, 100)}`];
  }
  return out;
}

/** Extra claim: after a cloud restore the nodes re-offer what the restored cloud lost and converge again. */
export async function restoreClaim(i: Inputs): Promise<Claim> {
  const t = mk("X3", "Cloud restore epoch");
  const r = i.restore as R | undefined;
  if (!r) return { id: "X3", name: "Cloud restore epoch", status: "not_run", evidence: [], failures: ["no restore epoch in this seed"] };
  t.note(`cloud ops: ${r.ops_at_backup} at backup, ${r.ops_before_restore} before the restore, ${r.ops_after_restore} right after it, ${r.ops_after_reoffer} after the nodes re-offered`);
  t.ok(r.ops_after_restore < r.ops_before_restore, "the restore really rolled the cloud back (it lost ops)", "the restore lost nothing: the scenario did not roll the cloud back");
  t.ok(r.ops_after_reoffer >= r.ops_before_restore, `the cloud holds every op again after ${r.settle_rounds} rounds (${r.reoffer_wall_ms} ms wall)`, `the cloud holds ${r.ops_after_reoffer} ops after the re-offer, it had ${r.ops_before_restore}`);
  t.ok(r.hub_epoch_changed === true, "the hub's round reported the epoch change", "no hub round reported an epoch change");
  const same = Object.keys(r.hashes_before).every((k) => r.hashes_before[k] === r.hashes_after[k]);
  t.ok(same, "no device's state changed through the rollback and the re-offer (state hash equal before and after, per device)", `device state hashes changed through the rollback: ${Object.keys(r.hashes_before).filter((k) => r.hashes_before[k] !== r.hashes_after[k]).join(", ")}`);
  return t.c;
}
