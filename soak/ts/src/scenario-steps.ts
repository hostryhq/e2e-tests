import * as T from "../../../../app-restaurant/src/data/trading";
import type { Dev, SoakNet } from "./net";
import { psql, type Svc } from "./svc";
import type { ArrivalIO, ScenarioFacts } from "./scenarios";

/**
 * The script of the review scenarios (code review H1-H5, M5; security review P2-H1, P2-H2). Each step records what it did in `ScenarioFacts`;
 * `scenario-claims.ts` judges it against the services afterwards. A step that cannot be made records nothing and the claim says "not seeded":
 * a scenario that did not happen never passes.
 *
 * The scenarios use the seeded generator of the run, a separate stream (`seed ^ 0x5c3a`) so the existing day's choices do not move.
 */
export type StepEnv = {
  net: SoakNet;
  scn: ScenarioFacts;
  mode: "settle" | "print";
  log(m: string): void;
  step<V>(name: string, fn: () => Promise<V>): Promise<V | undefined>;
  list(d: Dev): (e: string) => Array<Record<string, any>>;
  pay(d: Dev, checkId: string): Promise<{ billId: string; number: string } | undefined>;
  bump(d: Dev): void;
  pick<X>(xs: readonly X[]): X;
};

const ITEMS = ["it-dosa", "it-plain", "it-roast", "it-meal", "it-coffee", "it-chai", "it-vada"] as const;

/** A counter check with two lines, ready to bill. */
async function sale(env: StepEnv, d: Dev, lines = 2): Promise<string> {
  await d.signIn("Asha");
  const t = await T.newCounterCheck(d.rt.ctx);
  for (let i = 0; i < lines; i++) await T.addLine(d.rt.ctx, t, { itemId: env.pick(ITEMS), qtyMilli: 1000 });
  return t;
}

const lastOp = (d: Dev, from: number, intent: RegExp) => [...d.opLog.slice(from)].reverse().find((o) => intent.test(o.intent));
const billRow = (env: StepEnv, d: Dev, id: string): { total_paise: number; cgst_paise: number; sgst_paise: number } => {
  const b = env.list(d)("bill").find((x) => x.id === id);
  if (!b) throw new Error(`bill ${id} not on ${d.fx.name}`);
  return b as never;
};

/** Mid-day, internet cut: S1 (a payment recorded elsewhere), S2 (two tills credit one bill), S6 (a cited approval nobody granted), S7 (re-bill after payment). */
export async function midDayScenarios(env: StepEnv): Promise<void> {
  const { net, scn, step, list } = env;
  const a07 = net.dev("A07");
  const a08 = net.dev("A08");

  // S1 (H1): A07 issues the bill with part of the tender in the op; the rest is paid on A08, a different origin. At reconnect A08's op reaches
  // billing before A07's (see `driveArrival`), so billing projects the payment before its bill.
  await step("S1 payment recorded on another till", async () => {
    const t = await sale(env, a07);
    const due = (T.previewCheck(list(a07) as never, net.fx.outlet_id, t, net.clock.now())!.c.result.total_paise as number);
    const half = Math.floor(due / 2);
    const b = await T.settle(a07.rt.ctx, t, { payments: [{ tender: "cash", amount_paise: half }] });
    env.bump(a07);
    await net.sync();
    await a08.signIn("Asha");
    const before = new Set(list(a08)("payment").map((p) => p.id as string));
    await T.recordPayment(a08.rt.ctx, b.billId, [{ tender: "upi", amount_paise: due - half }]);
    const created = list(a08)("payment").filter((p) => !before.has(p.id as string) && p.bill_id === b.billId);
    if (created.length !== 1) throw new Error(`expected one new payment on A08, found ${created.length}`);
    scn.paymentFirst = { billId: b.billId, paymentId: created[0]!.id as string, issuer: "A07", payer: "A08" };
    await net.sync();
  });

  // S2 (H2): two tills that cannot hear each other each issue a full credit note for the same paid bill.
  await step("S2 two tills credit the same bill in full", async () => {
    const t = await sale(env, a07);
    const b = await env.pay(a07, t);
    if (!b) throw new Error("no bill");
    await net.sync();
    const bill = billRow(env, a07, b.billId);
    a07.lan.up = false;
    a08.lan.up = false;
    const notes: Array<{ number: string; totalPaise: number }> = [];
    try {
      for (const d of [a07, a08]) {
        await d.signIn("Meena");
        notes.push(await T.creditNote(d.rt.ctx, { billId: b.billId, reasonCodeId: "rc-cn-wrong", refundTender: "cash" }));
      }
    } finally {
      a07.lan.up = true;
      a08.lan.up = true;
    }
    scn.doubleCredit = { billId: b.billId, billTotalPaise: bill.total_paise, billTaxPaise: bill.cgst_paise + bill.sgst_paise, notes, devices: ["A07", "A08"] };
    await net.sync();
  });

  // S6 (P2-H1): a cashier comps a line citing an approval id nobody granted. The device only checks that an approval is cited.
  await step("S6 override citing an approval that does not exist", async () => {
    const t = await sale(env, a07);
    const line = list(a07)("order_line").find((l) => l.check_id === t);
    if (!line) throw new Error("no order line");
    const approvalId = a07.rt.ctx.newId();
    const from = a07.opLog.length;
    await T.compLine(a07.rt.ctx, { lineId: line.id as string, reasonCodeId: "rc-comp-owner", approvalId });
    const op = lastOp(a07, from, /comp/) ?? a07.opLog[a07.opLog.length - 1]!;
    scn.fakeApproval = { approvalId, intent: op.intent, op: { origin: op.origin, seq: op.seq } };
    const b = await env.pay(a07, t);
    if (b) {
      scn.fakeApproval.billId = b.billId;
      env.bump(a07);
    }
    await net.sync();
  });

  // S7 (P2-H2): a paid bill is re-billed with no approval. Refused on the device, or flagged by billing.
  await step("S7 re-bill after payment without approval", async () => {
    const t = await sale(env, a07);
    const b = await env.pay(a07, t);
    if (!b) throw new Error("no bill");
    await net.sync();
    const paymentsOnBill = list(a07)("payment").filter((p) => p.bill_id === b.billId).length;
    await a07.signIn("Meena");
    try {
      const rb = await T.rebillBill(a07.rt.ctx, { billId: b.billId, gstin: "33ABCDE1234F1Z5", reasonCodeId: "rc-cn-gstin" });
      scn.rebillPaid = { billId: b.billId, paymentsOnBill, outcome: "done", creditNumber: rb.credit, replacementNumbers: rb.bills };
    } catch (e) {
      scn.rebillPaid = { billId: b.billId, paymentsOnBill, outcome: "refused", code: (e as { code?: string }).code ?? (e instanceof Error ? e.name : String(e)), replacementNumbers: [] };
    }
    await net.sync();
  });
}

/** S4 (H4): B5K's clock is seven minutes fast. It issues a bill that the closing counter holds BEFORE it closes; no virtual time passes before the close. */
export async function fastClockBill(env: StepEnv): Promise<void> {
  const { net, scn } = env;
  await env.step("S4 bill from the fast-clock device, held by the closing counter", async () => {
    const b5k = net.dev("B5K");
    const a07 = net.dev("A07");
    const t = await sale(env, b5k, 1);
    const b = await env.pay(b5k, t);
    if (!b) throw new Error("no bill");
    env.bump(b5k);
    const op = [...b5k.opLog].reverse().find((o) => o.intent === "bill.finalize");
    if (!op) throw new Error("no bill.finalize op on B5K");
    let held = false;
    for (let i = 0; i < 6 && !held; i++) {
      for (const d of [b5k, a07]) await d.rt.sync.syncNow().catch(() => undefined);
      held = ((await a07.rt.engine.vector())[op.origin] ?? 0) >= op.seq;
    }
    const offsetMs = net.offsets.get("B5K") ?? 0;
    scn.fastClock = { billId: b.billId, op: { origin: op.origin, seq: op.seq }, offsetMs, atMs: net.clock.ms + offsetMs, closeMs: net.clock.ms, heldByCloser: held };
  });
}

/**
 * S5 (H5): the isolated device's counter goes back by one, as after a restore from an old backup, and it bills again: the same legal number under a
 * second bill id. Done after its late bill so that the first holder of the number is that bill.
 */
export async function duplicateNumber(env: StepEnv, late: { billId: string; number: string } | undefined): Promise<void> {
  const { net, scn } = env;
  await env.step("S5 same invoice number under a second bill id", async () => {
    if (!late) throw new Error("no late bill to repeat");
    const a09 = net.dev("A09");
    const code = a09.fx.series.find((s) => s.doc_type === "tax_invoice")!.code;
    await a09.rt.store.transact(async (tx) => {
      const row = tx.list("_s_series").find((r) => String(r.id).startsWith(`${code}|tax_invoice|`));
      if (!row) throw new Error("no series counter row on A09");
      tx.put("_s_series", { ...row, next: Number(row.next) - 1 } as never);
    });
    const t = await sale(env, a09, 1);
    const from = a09.opLog.length;
    const b = await env.pay(a09, t);
    if (!b) throw new Error("no bill");
    env.bump(a09);
    if (b.number !== late.number) throw new Error(`the rewound counter issued ${b.number}, not ${late.number}`);
    const op = a09.opLog.slice(from).find((o) => o.intent === "bill.finalize")!;
    scn.dupNumber = { number: b.number, firstBillId: late.billId, secondBillId: b.billId, secondOp: { origin: op.origin, seq: op.seq } };
  });
}

/** The finalize ops of A09 before the duplicate: the bill outside the Z's vector and the one made after the close. */
export function recordLateOps(env: StepEnv, bills: Array<{ billId: string } | undefined>): void {
  const ops = env.net.dev("A09").opLog.filter((o) => o.intent === "bill.finalize");
  env.scn.lateOps = bills.flatMap((b, i) => (b && ops[i] ? [{ origin: ops[i]!.origin, seq: ops[i]!.seq, billId: b.billId }] : []));
}

/** Staff-screen totals: wraps the previewCheck the script calls for the amount due; nothing may be written or numbered by it. */
export function totalProbe(env: StepEnv, d: Dev, due: () => number): number {
  const snap = () => env.list(d)("bill").length;
  const ops0 = d.opLog.length;
  const bills0 = snap();
  const v = due();
  env.scn.staffTotals.calls++;
  env.scn.staffTotals.opsCreated += d.opLog.length - ops0;
  env.scn.staffTotals.billsCreated += snap() - bills0;
  return v;
}

/** The services as `driveArrival` needs them: direct pushes, billing lookups, polling in wall-clock time. */
export function arrivalIO(net: SoakNet, svc: Svc, tenant: string, waitMs = 90_000): ArrivalIO {
  return {
    async pushDirect(name) {
      const d = net.dev(name);
      d.lan.up = false;
      d.net.up = true;
      const head = (await d.rt.engine.vector())[d.fx.device_id] ?? 0;
      const gwSeq = (): number => Number(psql("sync", `select coalesce(max(seq),0) from ops where tenant_id='${tenant}' and origin='${d.fx.device_id}'`)[0]?.[0] ?? 0);
      for (let i = 0; i < 40 && gwSeq() < head; i++) {
        net.clock.advance(5_000); // the runner fails over from the hub to the cloud after three failures or ten seconds
        await net.ctl.clock(net.clock.ms);
        await d.rt.sync.syncNow().catch(() => undefined);
      }
      if (gwSeq() < head) throw new Error(`${name} did not reach the cloud directly: gateway holds up to op ${gwSeq()}, the device's head is ${head}`);
    },
    async billingHasBill(id) {
      return (await svc.get("billing", `/v1/bills/${id}`)).status === 200;
    },
    async billingHasPayment(id) {
      return (await svc.all("billing", "/v1/payments")).some((p) => p.id === id);
    },
    async dayClosed() {
      return (await svc.all("billing", "/v1/business-days")).some((d) => d.status === "closed" || (d.revision_count ?? 0) > 0 || d.close);
    },
    async until(cond) {
      const end = Date.now() + waitMs;
      for (;;) {
        if (await cond()) return true;
        if (Date.now() > end) return false;
        await new Promise((r) => setTimeout(r, 2_000));
      }
    },
  };
}
