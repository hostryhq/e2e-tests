import { detect, seriesGaps, type BillRow, type CreditNoteRow } from "@hostry/client-core";
import { compareDigests, deviceDigest } from "./digest";
import type { Facts } from "./day";
import type { Dev, SoakNet } from "./net";
import { psql, type Svc } from "./svc";

export type Claim = { id: string; name: string; status: "pass" | "fail" | "not_run"; evidence: string[]; failures: string[] };

type R = Record<string, any>;
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

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
};

function mk(id: string, name: string): { c: Claim; ok(cond: boolean, pass: string, fail: string): void; note(s: string): void } {
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
const text = (p: unknown): string => Buffer.from(p as Uint8Array).toString("latin1");

export async function evaluate(i: Inputs): Promise<{ claims: Claim[]; extra: R }> {
  const { net, facts: f, svc, date } = i;
  const devs = [...net.devs.values()];
  const by = (n: string): Dev => net.dev(n);
  const a07 = by("A07");
  const extra: R = {};

  const bills = (await rowsOf(a07, "bill")) as unknown as BillRow[];
  const notes = (await rowsOf(a07, "credit_note")) as unknown as CreditNoteRow[];
  const pays = await rowsOf(a07, "payment");
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
    const hashes = await Promise.all(devs.map(async (d) => [d.fx.name, await d.rt.engine.stateHash()] as const));
    const uniq = new Set(hashes.map((h) => h[1]));
    t.ok(uniq.size === 1, `${devs.length} devices hold one state hash ${[...uniq][0]!.slice(0, 16)}…`, `state hashes differ: ${JSON.stringify(hashes.map((h) => [h[0], h[1].slice(0, 8)]))}`);
    const vecs = await Promise.all(devs.map((d) => d.rt.engine.vector()));
    t.ok(vecs.every((v) => eq(v, vecs[0])), "every device holds the same outlet-stream version vector", "version vectors differ between devices");
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
      const g = await seriesGaps(d.rt.store);
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
    const others = sBills.filter((b: R) => b.id !== f.wrongTax?.billId);
    t.ok(others.every((b: R) => st(b) === "verified"), `${others.length} bills verified by billing (all but the seeded one)`, `bills not verified: ${JSON.stringify(cnt(others))}`);
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
      if (orig !== 1) wrong++;
    }
    t.ok(wrong === 0, `each of ${Object.keys(per).length} bills has exactly one original print job`, `${wrong} bill(s) without exactly one original print: ${JSON.stringify(Object.entries(per).filter(([, v]) => v !== 1).slice(0, 6))}`);
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
      for (const e of Object.keys((await import("./entities.generated.json")).default as R)) m[e] = await rowsOf(a07, e);
      return m;
    };
    const rows = await entitiesOf();
    for (const [owner, svcDigest] of [["orders", oDigest], ["billing", bDigest]] as const) {
      if (!svcDigest?.entities) {
        t.ok(false, "", `${owner} returned no digest: ${JSON.stringify(svcDigest).slice(0, 160)}`);
        continue;
      }
      const dev = deviceDigest(owner, date, rows);
      const diff = compareDigests(dev, svcDigest);
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
  const t10: Claim = { id: "T10", name: "Trading is never gated", status: "not_run", evidence: [], failures: ["not exercisable on this build: app-restaurant has no entitlement snapshot or subscription check (grep: none); the nearest condition, an expired offline pack, only refuses new PIN sign-ins in StubIdentity and was not run"] };

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
    const revTotal = sum(revisions.map((r: R) => r.totals?.total?.amount_paise ?? r.delta?.total?.amount_paise ?? 0));
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
      const invoices = presented.filter((c) => billedChecks.has(c));
      t.ok(presented.length > 0 && invoices.length === presented.length, `print mode: every presented check (${presented.length}) is finalised by Present`, `print mode: ${presented.length - invoices.length} presented check(s) have no bill`);
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
    const blackoutBills = bills.filter((b) => b.number.startsWith(by("A08").fx.series?.[0]?.code ?? "~")).length;
    t.ok(blackoutBills > 0, `bills finalised on the battery counter in the blackout keep their series (${by("A08").fx.series?.[0]?.code}: gapless per T3) and their original print exists (T6)`, "no bill was finalised in the blackout");
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
  for (const r of e.refs) res.push(await net.ctl.erase(r));
  t.ok(res.every((r) => r.status === 200), `gateway erasure issued for ${res.length} op(s) (via Gateway.ErasePII: no HTTP route exists, see findings)`, `erase refused: ${JSON.stringify(res.map((r) => [r.status, r.body.slice(0, 80)]))}`);
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
  for (const e of Object.keys((await import("./entities.generated.json")).default as R)) rows[e] = await rowsOf(a07, e);
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
