import * as T from "../../../../app-restaurant/src/data/trading";
import { KITCHEN_PRINTER } from "../../../../app-restaurant/src/data/trading/bill-printer";

import { ENTITIES, Snapshot } from "../../../../app-restaurant/src/data/app-data";
import type { BillRow } from "@hostry/client-core";
import { publishConfig, type ConfigReport } from "./config";
import { Clock, SoakNet, type Dev } from "./net";
import { rng } from "./rng";

/** What the script did and what it deliberately seeded: the claims check the converged state against these. */
export type Facts = {
  seed: number;
  mode: "settle" | "print";
  config: ConfigReport | undefined;
  steps: Array<{ name: string; ok: boolean; error?: string }>;
  events: string[];
  z: { zNumber: string; totalPaise: number; billCount: number } | undefined;
  z2: { zNumber: string; totalPaise: number; billCount: number } | undefined;
  blockedCloseCode: string | undefined;
  blackout: { given?: string; stale?: string; recent?: string; bookNumber?: string; bookEntriesMade: number; settleRounds?: number | undefined; settleWallMs?: number };
  wipeSettleRounds?: number | undefined;
  doublePay: { billId: string; payments: string[] } | undefined;
  race: { lineId: string; checks: string[] } | undefined;
  wrongTax: { billId: string; number: string } | undefined;
  lateBill: { billId: string; number: string } | undefined;
  hubKills: number;
  hubWipes: number;
  restarts: string[];
  lostAcks: number;
  kotLatencyMs: number[];
  kotsSentWhileCut: string[];
  creditNotes: string[];
  rebills: string[];
  approvals: number;
  billsMadeBy: Record<string, number>;
  restoreEpoch: boolean;
  erasure: { checkId: string; billId: string; number: string; name: string; gstin: string; refs: Array<{ intent: string; origin: string; stream: string; seq: number }> } | undefined;
  kitchenPre: { kots: number; kotLines: number; byStation: Record<string, { missing: string[]; duplicateLines: number }> } | undefined;
};

export type DayOpts = { seed: number; mode: "settle" | "print"; tables: number; counterSales: number; restoreEpoch: boolean; clock: Clock };

/** IST calendar date of a virtual instant. */
export const istDate = (ms: number): string => new Date(ms + 5.5 * 3_600_000).toISOString().slice(0, 10);

const ITEMS = ["it-dosa", "it-plain", "it-roast", "it-meal", "it-chicken", "it-coffee", "it-chai", "it-lime", "it-vada", "it-bajji", "it-water"] as const;

export async function runDay(net: SoakNet, o: DayOpts): Promise<Facts> {
  const R = rng(o.seed);
  const clock = o.clock;
  const f: Facts = {
    seed: o.seed, mode: o.mode, config: undefined, steps: [], events: [], z: undefined, z2: undefined, blockedCloseCode: undefined,
    blackout: { bookEntriesMade: 0 }, doublePay: undefined, race: undefined, wrongTax: undefined, lateBill: undefined, hubKills: 0, hubWipes: 0,
    restarts: [], lostAcks: 0, kotLatencyMs: [], kotsSentWhileCut: [], creditNotes: [], rebills: [], approvals: 0, billsMadeBy: {}, restoreEpoch: o.restoreEpoch, erasure: undefined, kitchenPre: undefined,
  };
  const log = (m: string): void => void f.events.push(`${new Date(clock.ms).toISOString().slice(11, 19)}Z ${m}`);
  const step = async <V>(name: string, fn: () => Promise<V>): Promise<V | undefined> => {
    try {
      const v = await fn();
      f.steps.push({ name, ok: true });
      return v;
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      f.steps.push({ name, ok: false, error: msg });
      log(`STEP FAILED ${name}: ${msg}`);
      return undefined;
    }
  };
  const list = (d: Dev) => (e: string) => d.rt.data.snapshot().list(e);
  const dueOf = (d: Dev, checkId: string): number => T.previewCheck(list(d), net.fx.outlet_id, checkId, clock.now())!.c.result.total_paise;
  const pay = async (d: Dev, checkId: string): Promise<{ billId: string; number: string } | undefined> => {
    const due = dueOf(d, checkId);
    const r = R.next();
    const payments =
      r < 0.5 ? [{ tender: "cash" as const, amount_paise: due }] : r < 0.75 ? [{ tender: "upi" as const, amount_paise: due }] : (() => { const h = Math.floor(due / 2); return [{ tender: "cash" as const, amount_paise: h }, { tender: "card" as const, amount_paise: due - h }]; })();
    f.billsMadeBy[d.fx.name] = (f.billsMadeBy[d.fx.name] ?? 0) + 1;
    if (o.mode === "print") {
      // number_at=print: Present finalises the invoice; the payment is recorded against it afterwards.
      const p = await T.present(d.rt.ctx, checkId);
      if (p.kind !== "invoice") throw new Error("print mode: Present did not finalise the invoice");
      await T.recordPayment(d.rt.ctx, p.billId, payments);
      return { billId: p.billId, number: p.number };
    }
    const b = await T.settle(d.rt.ctx, checkId, { payments });
    return { billId: b.billId, number: b.number };
  };
  const approve = async (d: Dev, perm: string, requester: string): Promise<string> => {
    const ap = await d.rt.identity.approve(net.S("Meena").id, net.S("Meena").pin, perm, requester);
    if (!ap.ok) throw new Error(`approval ${perm}: ${ap.reason}`);
    f.approvals++;
    return ap.approvalId;
  };

  // --- Cast. The first device holds nothing: configuration is published through the legal routes below. ---
  const a07 = await net.add("A07");
  const a08 = await net.add("A08");
  const a09 = await net.add("A09");
  const caps = [await net.add("B3K"), await net.add("B4K"), await net.add("B5K", { offsetMs: 7 * 60_000 })]; // B5K's clock runs seven minutes fast
  const kitchen = await net.add("K9K");
  const bar = await net.add("K8K");
  log("cast up: 3 counters, 3 captains, 2 KDS, one hub; morning: internet up for the configuration push");
  await net.setInternet(true);
  f.config = await publishConfig(net, a07, o.mode);
  await net.settle();
  await net.setInternet(false);
  log("internet cut for the whole trading day");
  log(`configuration published: ${f.config.device_ops.filter((x) => x.ok).length}/${f.config.device_ops.length} device intents, ${f.config.emits.filter((x) => x.status === 200).length}/${f.config.emits.length} cloud emits`);

  // Two devices open the same date while partitioned from each other (A1.7).
  net.lan(false);
  for (const d of [a07, a08]) {
    await d.signIn("Meena");
    await step(`open-day ${d.fx.name}`, () => T.ensureDayOpen(d.rt.ctx));
  }
  net.lan(true);
  clock.minutes(1);
  await net.sync();
  await a07.signIn("Asha");
  const shiftId = (await step("start-shift", () => T.startShift(a07.rt.ctx, 200_000))) ?? "";
  await net.sync();
  await a08.signIn("Asha");
  for (const c of caps) await c.signIn("Ravi");

  // --- Lunch: captains seat tables, send KOTs to the kitchen and bar; the KDS screens bump; everything offline from the cloud. ---
  const tableChecks: Array<{ cap: Dev; checkId: string; seatingId: string; tableId: string }> = [];
  for (let i = 0; i < o.tables; i++) {
    const cap = caps[i % caps.length]!;
    const tableId = `tb-${(i % 8) + 1}`;
    await step(`table ${tableId} by ${cap.fx.name}`, async () => {
      if (T.openSeatingOf(list(cap), tableId)) return;
      const t = await T.openTableCheck(cap.rt.ctx, tableId);
      const lines = R.int(1, 3);
      for (let l = 0; l < lines; l++) {
        const item = R.pick(ITEMS);
        const mods = item === "it-chicken" ? ["md-hot"] : undefined;
        await T.addLine(cap.rt.ctx, t.checkId, { itemId: item, qtyMilli: R.int(1, 3) * 1000, ...(mods ? { modifierIds: mods } : {}) });
      }
      const kots = await T.sendKot(cap.rt.ctx, t.checkId);
      f.kotsSentWhileCut.push(...kots);
      tableChecks.push({ cap, checkId: t.checkId, seatingId: t.seatingId, tableId });
    });
    clock.minutes(R.int(1, 4));
    if (i % 3 === 2) await net.sync();
  }
  await net.sync();

  // KOT latency on the LAN: send, then poll captain and KDS rounds until the KDS holds the ticket (wall clock, p95 later).
  for (let i = 0; i < 12; i++) {
    const cap = caps[i % caps.length]!;
    await step(`latency probe ${i}`, async () => {
      const t = await T.newCounterCheck(a07.rt.ctx);
      await T.addLine(a07.rt.ctx, t, { itemId: R.pick(["it-dosa", "it-vada", "it-plain"]), qtyMilli: 1000 });
      const t0 = performance.now();
      const [kot] = await T.sendKot(a07.rt.ctx, t);
      let seen = false;
      for (let n = 0; n < 20 && !seen; n++) {
        await a07.rt.sync.syncNow();
        await kitchen.rt.sync.syncNow();
        await kitchen.rt.data.refresh();
        seen = kitchen.rt.data.snapshot().list<{ id: string }>("kot").some((k) => k.id === kot);
      }
      if (!seen) throw new Error("KDS never saw the probe ticket");
      f.kotLatencyMs.push(performance.now() - t0);
      f.kotsSentWhileCut.push(kot!);
      // the probe check is settled as a counter sale below
      await T.settle(a07.rt.ctx, t, { payments: [{ tender: "cash", amount_paise: dueOf(a07, t) }] });
      f.billsMadeBy.A07 = (f.billsMadeBy.A07 ?? 0) + 1;
      void cap;
    });
  }
  await net.sync();

  // The KDS bumps what is cooked (each station's screen its own tickets).
  const bumpAll = async (): Promise<void> => {
    for (const [k, code] of [[kitchen, "KITCHEN"], [bar, "BAR"]] as const) {
      await k.rt.data.refresh();
      const kots = k.rt.data.snapshot().list<{ id: string; station_code: string }>("kot").filter((x) => x.station_code === code);
      const bumped = new Set(k.rt.data.snapshot().list<{ kot_id: string; status: string }>("kot_line").filter((l) => l.status === "ready").map((l) => l.kot_id));
      for (const kot of kots) if (!bumped.has(kot.id)) await step(`bump ${kot.id}`, () => T.bump(k.rt.ctx, kot.id));
    }
  };
  await bumpAll();
  await net.sync();

  // --- Kitchen printer jams for a while on one captain's tablet: the order is not lost, the job waits and prints on retry. ---
  {
    const cap = caps[0]!;
    await step("printer jam and retry", async () => {
      const t = await T.openTableCheck(cap.rt.ctx, "tb-8");
      await T.addLine(cap.rt.ctx, t.checkId, { itemId: "it-vada", qtyMilli: 1000 });
      cap.rt.fakes.kitchen.failWith = "paper_out";
      const [jam] = await T.sendKot(cap.rt.ctx, t.checkId);
      f.kotsSentWhileCut.push(jam!);
      cap.rt.fakes.kitchen.failWith = undefined;
      clock.minutes(1);
      await cap.rt.fakes.hub.flush();
      tableChecks.push({ cap, checkId: t.checkId, seatingId: t.seatingId, tableId: "tb-8" });
    });
  }

  // --- Floor operations: split by item, move item, move table, merge tables, modifiers. ---
  const open = tableChecks.filter((t) => t.tableId !== "tb-8");
  if (open.length >= 4) {
    const [t1, t2, t3, t4] = open;
    await step("split by item", async () => {
      const lines = list(t1!.cap)("order_line").filter((l) => (l as { check_id: string }).check_id === t1!.checkId) as Array<{ id: string; qty_milli: number }>;
      if (lines.length >= 2) await T.splitBill(t1!.cap.rt.ctx, t1!.checkId, { [lines[0]!.id]: lines[0]!.qty_milli });
    });
    await step("move item", async () => {
      const lines = list(t2!.cap)("order_line").filter((l) => (l as { check_id: string }).check_id === t2!.checkId) as Array<{ id: string; qty_milli: number }>;
      if (lines.length >= 2) await T.moveItems(t2!.cap.rt.ctx, { [lines[0]!.id]: lines[0]!.qty_milli }, { checkId: t3!.checkId });
    });
    await step("move table", async () => {
      if (!T.openSeatingOf(list(t4!.cap), "tb-7")) await T.moveTable(t4!.cap.rt.ctx, t4!.seatingId, "tb-7");
    });
    await net.sync();
  }

  // --- Counter: approvals (discount over limit, comp, cancel after KOT), settle, mixed and partial tender, reprint. ---
  const counters = [a07, a08];
  const settledBills: Array<{ billId: string; number: string; dev: Dev }> = [];
  await step("settle table checks", async () => {
    await net.sync();
    for (const [i, t] of tableChecks.entries()) {
      const d = counters[i % 2]!;
      await d.signIn("Asha");
      await net.sync();
      await step(`bill ${t.tableId}`, async () => {
        const check = list(d)("check").find((c) => (c as { id: string }).id === t.checkId) as { status?: string } | undefined;
        if (!check || check.status !== "open") return;
        if (i === 0 && o.mode === "settle") {
          await T.present(d.rt.ctx, t.checkId);
          if (o.mode === "settle") {
            const n = list(d)("bill").length;
            if (n !== 0 && !f.events.some((e) => e.includes("first bill seen"))) log(`first bill seen`);
          }
        }
        if (i === 3 && o.mode === "settle") {
          // A present, an edit and a second present before payment (A1.7): no number is consumed until the payment.
          await T.present(d.rt.ctx, t.checkId);
          await step("edit after present", async () => {
            await T.addLine(d.rt.ctx, t.checkId, { itemId: "it-chai", qtyMilli: 1000 });
          });
          await T.present(d.rt.ctx, t.checkId);
        }
        if (i === 1) {
          const ap = await approve(d, "bill.discount.over_limit", net.S("Asha").id);
          await T.applyDiscount(d.rt.ctx, { checkId: t.checkId, kind: "percent", value: 1500, reasonCodeId: "rc-disc-complaint", approvalId: ap });
        }
        if (i === 2) {
          const lines = list(d)("order_line").filter((l) => (l as { check_id: string; status?: string }).check_id === t.checkId) as Array<{ id: string }>;
          if (lines[0]) {
            const ap = await approve(d, "bill.line.comp", net.S("Asha").id);
            await T.compLine(d.rt.ctx, { lineId: lines[0].id, reasonCodeId: "rc-comp-owner", approvalId: ap });
          }
        }
        const b = await pay(d, t.checkId);
        if (b) settledBills.push({ ...b, dev: d });
        if (i === 0 && b) await T.reprintBill(d.rt.ctx, b.billId);
      });
      clock.minutes(R.int(1, 3));
    }
  });

  // Counter sales through the afternoon.
  for (let i = 0; i < o.counterSales; i++) {
    const d = counters[i % 2]!;
    await step(`counter sale ${i}`, async () => {
      await d.signIn("Asha");
      const t = await T.newCounterCheck(d.rt.ctx, R.chance(0.2) ? "takeaway" : "counter");
      const n = R.int(1, 3);
      for (let l = 0; l < n; l++) {
        const it = R.pick(ITEMS);
        await T.addLine(d.rt.ctx, t, { itemId: it, qtyMilli: R.int(1, 4) * 1000, ...(it === "it-chicken" ? { modifierIds: ["md-hot"] } : {}) });
      }
      const b = await pay(d, t);
      if (b) settledBills.push({ ...b, dev: d });
    });
    clock.minutes(R.int(1, 5));
    if (i % 5 === 4) await net.sync();
  }
  await net.sync();

  // A sale with the customer's details (name, GSTIN): the personal data the erasure claim removes everywhere.
  await step("sale with customer details", async () => {
    await a07.signIn("Asha");
    const before = a07.opLog.length;
    const t = await T.newCounterCheck(a07.rt.ctx);
    await T.addLine(a07.rt.ctx, t, { itemId: "it-meal", qtyMilli: 1000 });
    const name = "Erasure Test Customer";
    const gstin = "33ABCDE1234F1Z5";
    const b = await T.settle(a07.rt.ctx, t, { payments: [{ tender: "upi", amount_paise: dueOf(a07, t) }], customerGstin: gstin, customerName: name });
    f.billsMadeBy.A07 = (f.billsMadeBy.A07 ?? 0) + 1;
    f.erasure = { checkId: t, billId: b.billId, number: b.number, name, gstin, refs: a07.opLog.slice(before).filter((o) => o.intent === "bill.customer_details.edit" || o.intent === "bill.finalize") };
  });
  await net.sync();

  // Corrections: a credit note on a counter sale, a re-bill of a table bill with the customer's GSTIN.
  await step("credit note and re-bill", async () => {
    await a07.signIn("Meena");
    await net.sync();
    const cnTarget = settledBills.filter((b) => b.dev.fx.name === "A07").pop();
    if (cnTarget) {
      const cn = await T.creditNote(a07.rt.ctx, { billId: cnTarget.billId, reasonCodeId: "rc-cn-wrong", refundTender: "cash" });
      f.creditNotes.push(cn.number);
    }
    const rbTarget = settledBills.filter((b) => b.dev.fx.name === "A07")[0];
    if (rbTarget) {
      const rb = await T.rebillBill(a07.rt.ctx, { billId: rbTarget.billId, gstin: "33ABCDE1234F1Z5", reasonCodeId: "rc-cn-gstin" });
      f.creditNotes.push(rb.credit);
      f.rebills.push(...rb.bills);
    }
  });
  await net.sync();

  // --- Hub killed (disk intact) and restarted; a push whose answer is lost; one captain killed and restarted. ---
  await step("hub kill and restart", async () => {
    await net.ctl.hub("stop");
    f.hubKills++;
    const t = await T.newCounterCheck(a08.rt.ctx);
    await T.addLine(a08.rt.ctx, t, { itemId: "it-coffee", qtyMilli: 1000 });
    await a08.rt.sync.syncNow().catch(() => undefined); // the hub is down: the op stays pending, visibly
    await net.ctl.hub("start");
    a08.hubT.faults.push({ kind: "lose_ack", n: 1 });
    await a08.rt.sync.syncNow().catch(() => undefined);
    f.lostAcks++;
    await net.sync();
    const b = await pay(a08, t);
    if (b) settledBills.push({ ...b, dev: a08 });
  });
  await step("captain killed and restarted", async () => {
    await net.restart("B4K");
    f.restarts.push("B4K");
    await net.devs.get("B4K")!.signIn("Ravi");
    await net.sync();
  });

  // --- Seeded conflicts (T7): a double payment and one line moved onto two bills by two devices that cannot hear each other. ---
  await a07.signIn("Meena");
  await a08.signIn("Meena");
  await step("seeded double payment", async () => {
    const t = await T.newCounterCheck(a07.rt.ctx);
    await T.addLine(a07.rt.ctx, t, { itemId: "it-meal", qtyMilli: 1000 });
    const due = dueOf(a07, t);
    const b = await T.settle(a07.rt.ctx, t, { payments: [{ tender: "cash", amount_paise: Math.floor(due / 2) }] }); // short on purpose: the rest is paid later
    await net.sync();
    a07.lan.up = false; // A07 and A08 cannot hear each other
    a08.lan.up = false;
    const rest = due - Math.floor(due / 2);
    await T.recordPayment(a07.rt.ctx, b.billId, [{ tender: "upi", amount_paise: rest }]);
    await T.recordPayment(a08.rt.ctx, b.billId, [{ tender: "cash", amount_paise: rest }]);
    a07.lan.up = true;
    a08.lan.up = true;
    await net.sync();
    f.doublePay = { billId: b.billId, payments: list(a07)("payment").filter((p) => (p as { bill_id: string }).bill_id === b.billId).map((p) => (p as { id: string }).id) };
  });
  await step("seeded line on two bills", async () => {
    const t = await T.newCounterCheck(a07.rt.ctx);
    await T.addLine(a07.rt.ctx, t, { itemId: "it-roast", qtyMilli: 1000 });
    await net.sync();
    a07.lan.up = false;
    a08.lan.up = false;
    const b1 = await T.settle(a07.rt.ctx, t, { payments: [{ tender: "cash", amount_paise: dueOf(a07, t) }] });
    const b2 = await T.settle(a08.rt.ctx, t, { payments: [{ tender: "upi", amount_paise: dueOf(a08, t) }] });
    a07.lan.up = true;
    a08.lan.up = true;
    f.race = { lineId: (list(a07)("order_line").find((l) => (l as { check_id: string }).check_id === t) as { id: string }).id, checks: [t, b1.billId, b2.billId] };
    await net.sync();
  });
  // Closing the conflicts with compensating ops: refund the duplicate payment, credit the second bill.
  await step("close conflicts by refund and credit note", async () => {
    if (f.doublePay) {
      const pays = list(a07)("payment").filter((p) => (p as { bill_id: string }).bill_id === f.doublePay!.billId) as Array<{ id: string; amount_paise: number }>;
      const dup = pays[pays.length - 1]!;
      const ap = await approve(a07, "payment.refund", net.S("Meena").id).catch(() => undefined);
      const r = await T.refundPayment(a07.rt.ctx, { paymentId: dup.id, amountPaise: dup.amount_paise, reasonCodeId: "rc-cn-wrong", ...(ap ? { approvalId: ap } : {}) });
      void r;
    }
    if (f.race) {
      const second = f.race.checks[2]!;
      const cn = await T.creditNote(a07.rt.ctx, { billId: second, reasonCodeId: "rc-cn-wrong", refundTender: "cash" });
      f.creditNotes.push(cn.number);
    }
    await net.sync();
  });

  // --- Evening: blackout. Hub, router and the counter's mains power are off; captains work alone on battery. ---
  clock.minutes(60);
  await net.sync();
  log("BLACKOUT: LAN, hub and the A07 counter are off");
  a07.powered = false;
  await net.ctl.hub("stop");
  f.hubKills++;
  net.lan(false);
  const cap0 = caps[0]!;
  await step("blackout captain flow", async () => {
    const t3 = await T.openTableCheck(cap0.rt.ctx, "tb-6");
    await T.addLine(cap0.rt.ctx, t3.checkId, { itemId: "it-bajji", qtyMilli: 1000 });
    cap0.rt.fakes.kitchen.failWith = "offline";
    const [given] = await T.sendKot(cap0.rt.ctx, t3.checkId);
    await T.handover(cap0.rt.ctx, given!, "by_hand");
    cap0.rt.fakes.hub.remove(KITCHEN_PRINTER, given!);
    f.blackout.given = given;
    clock.minutes(10);
    await T.addLine(cap0.rt.ctx, t3.checkId, { itemId: "it-plain", qtyMilli: 1000 });
    const [stale] = await T.sendKot(cap0.rt.ctx, t3.checkId);
    cap0.rt.fakes.hub.remove(KITCHEN_PRINTER, stale!);
    f.blackout.stale = stale;
    clock.minutes(20); // the stale ticket is 21 minutes old when the LAN returns (the station holds tickets older than 15)
    await T.addLine(cap0.rt.ctx, t3.checkId, { itemId: "it-vada", qtyMilli: 1000 });
    const [recent] = await T.sendKot(cap0.rt.ctx, t3.checkId);
    cap0.rt.fakes.hub.remove(KITCHEN_PRINTER, recent!);
    f.blackout.recent = recent;
    cap0.rt.fakes.kitchen.failWith = undefined;
    tableChecks.push({ cap: cap0, checkId: t3.checkId, seatingId: t3.seatingId, tableId: "tb-6" });
  });
  // The second counter (on battery) bills during the blackout from its own series, and types a page of the paper bill book.
  await step("blackout bill and bill-book entry", async () => {
    await a08.signIn("Meena");
    const t = await T.newCounterCheck(a08.rt.ctx);
    await T.addLine(a08.rt.ctx, t, { itemId: "it-dosa", qtyMilli: 2000 });
    const b = await pay(a08, t);
    if (b) settledBills.push({ ...b, dev: a08 });
    f.blackout.bookNumber = "MB1/2627/000007";
    const book = await T.bookEntry(a08.rt.ctx, {
      number: f.blackout.bookNumber,
      invoiceDate: istDate(clock.ms),
      bookTotalPaise: 8400,
      header: { order_type: "counter" },
      lines: [{ id: "paper-1", item_id: "it-dosa", name: "Masala Dosa", category_name: "Dosa", qty_milli: 1000, unit_price_paise: 8000, modifier_delta_paise: 0, tax_class: "fnb_standard" }],
    });
    f.blackout.bookEntriesMade++;
    if (!book.matchesBook) throw new Error("book entry total differs from the book");
  });
  clock.minutes(1);
  log("POWER RETURNS");
  net.lan(true);
  await net.ctl.hub("start");
  a07.powered = true;
  // The same paper page typed again on the other counter (a manager did not know it was entered).
  await step("same bill-book page typed again", async () => {
    await a07.signIn("Meena");
    const book = await T.bookEntry(a07.rt.ctx, {
      number: f.blackout.bookNumber!,
      invoiceDate: istDate(clock.ms),
      bookTotalPaise: 8400,
      header: { order_type: "counter" },
      lines: [{ id: "paper-1", item_id: "it-dosa", name: "Masala Dosa", category_name: "Dosa", qty_milli: 1000, unit_price_paise: 8000, modifier_delta_paise: 0, tax_class: "fnb_standard" }],
    });
    f.blackout.bookEntriesMade++;
    void book;
  });
  {
    const t0 = Date.now();
    const rounds = await step("converge after the power returns", () => net.settle(40));
    f.blackout.settleRounds = rounds;
    f.blackout.settleWallMs = Date.now() - t0;
  }
  // What arrived on the KDS after the LAN returned: the ticket handed over by hand and the stale one never print as originals.
  await step("arrived KOTs on the kitchen screen", async () => {
    for (const id of [f.blackout.recent, f.blackout.given, f.blackout.stale]) if (id) T.ingestArrivedKot(kitchen.rt.ctx, id);
    await kitchen.rt.fakes.hub.flush();
  });
  await net.sync();
  // The hub machine dies for good: new disk. Every device still holds its own ops and re-offers them (T5: nothing lost).
  await step("hub disk wiped", async () => {
    await net.ctl.hub("wipe");
    f.hubWipes++;
    f.hubKills++;
    f.wipeSettleRounds = await net.settle(40);
  });

  // --- Evening: the blackout table is billed; the day is blocked until every order line is resolved (T8). ---
  await a07.signIn("Meena");
  await net.sync();
  await step("billing the blackout table", async () => {
    const t = [...tableChecks].reverse().find((x) => x.tableId === "tb-6")!;
    // A new order line on a table that nobody bills yet keeps the day blocked.
    try {
      await T.closeDay(a07.rt.ctx);
      f.blockedCloseCode = "closed";
    } catch (e) {
      f.blockedCloseCode = (e as { code?: string }).code ?? String(e);
    }
    await a08.signIn("Asha");
    const b = await pay(a07, t.checkId);
    if (b) settledBills.push({ ...b, dev: a07 });
  });
  // The rest of the open checks are billed or cancelled with approval.
  for (const t of tableChecks) {
    const check = list(a07)("check").find((c) => (c as { id: string }).id === t.checkId) as { status?: string } | undefined;
    if (check?.status === "open") {
      await step(`close-out ${t.tableId}`, async () => {
        const b = await pay(a07, t.checkId);
        if (b) settledBills.push({ ...b, dev: a07 });
      });
    }
  }
  // Remaining unresolved checks (drafts without a bill) are cancelled with approval.
  await step("cancel remaining checks", async () => {
    for (const u of T.unresolvedChecks(list(a07))) {
      const ap = await approve(a07, "bill.cancel", net.S("Meena").id).catch(() => undefined);
      void ap;
      await T.cancelCheck(a07.rt.ctx, u.checkId, "rc-cancel-mind").catch(() => undefined);
    }
  });
  await net.sync();

  // --- Day end. A09 (a third billing device) is isolated across the close and bills late; A07 and A08 close while partitioned. ---
  clock.minutes(120);
  await net.sync();
  log("A09 isolated; A07 and A08 partitioned from each other for the close");
  await net.sync();
  // Kitchen audit while the internet is still cut: every KOT the counter holds is on the KDS of its station, each line once.
  {
    const kots = list(a07)("kot") as Array<{ id: string; station_code: string }>;
    const kotLines = (d: Dev) => list(d)("kot_line") as Array<{ id: string; kot_id: string; order_line_id: string }>;
    const audit: Record<string, { missing: string[]; duplicateLines: number }> = {};
    for (const [k, code] of [[kitchen, "KITCHEN"], [bar, "BAR"]] as const) {
      const mine = kots.filter((x) => x.station_code === code);
      const have = new Set((list(k)("kot") as Array<{ id: string }>).map((x) => x.id));
      const lines = kotLines(k).filter((l) => mine.some((m) => m.id === l.kot_id));
      const seen = new Map<string, number>();
      for (const l of lines) seen.set(`${l.kot_id}|${l.order_line_id}`, (seen.get(`${l.kot_id}|${l.order_line_id}`) ?? 0) + 1);
      audit[code] = { missing: mine.filter((m) => !have.has(m.id)).map((m) => m.id), duplicateLines: [...seen.values()].filter((n) => n > 1).length };
    }
    f.kitchenPre = { kots: kots.length, byStation: audit, kotLines: kotLines(a07).length };
  }
  a09.lan.up = false; // A09 never hears of the close
  await a09.signIn("Asha");
  // A bill on A09 before the close, with the tax rate corrupted on that device only (seeded wrong tax, T4).
  await step("seeded wrong-tax bill on A09", async () => {
    const t = await T.newCounterCheck(a09.rt.ctx);
    await T.addLine(a09.rt.ctx, t, { itemId: "it-dosa", qtyMilli: 2000 });
    await T.sendKot(a09.rt.ctx, t); // the ticket is sent (and printed) before the doctored rules are installed
    const dd = a09.rt.data as unknown as { snapshot: () => { list: (e: string) => Array<Record<string, unknown>> } };
    const orig = dd.snapshot.bind(dd);
    const real = orig();
    const tables: Record<string, Array<Record<string, unknown>>> = {};
    for (const e of ENTITIES) tables[e] = real.list(e);
    tables.tax_rule = tables.tax_rule!.map((r) => (r.gst_applies ? { ...r, cgst_bp: Number(r.cgst_bp) + 100, sgst_bp: Number(r.sgst_bp) + 100 } : r));
    dd.snapshot = () => new Snapshot(tables as never) as never; // the amount due the cashier sees
    // ... and the rules the finalising transaction reads (it reads the store, not the snapshot).
    const st = a09.rt.store as unknown as { transact: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> };
    const origTx = st.transact.bind(st);
    const corrupt = (rows: Array<Record<string, unknown>>) => rows.map((r) => (r.gst_applies ? { ...r, cgst_bp: Number(r.cgst_bp) + 100, sgst_bp: Number(r.sgst_bp) + 100 } : r));
    st.transact = (fn) =>
      origTx((tx) =>
        fn(
          new Proxy(tx as object, {
            get(target, p, recv) {
              const v = Reflect.get(target, p, recv) as unknown;
              if (p === "list") return (e: string) => (e === "tax_rule" ? corrupt((v as (e: string) => Array<Record<string, unknown>>).call(target, e)) : (v as (e: string) => unknown).call(target, e));
              return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
            },
          }),
        ),
      );
    let printError = "";
    try {
      await pay(a09, t);
    } catch (e) {
      // The bill is recorded before it is printed; the print reads the doctored snapshot and cannot find the new bill.
      printError = e instanceof Error ? e.message : String(e);
    } finally {
      dd.snapshot = orig as never;
      st.transact = origTx as never;
    }
    const code = a09.fx.series.find((s) => s.doc_type === "tax_invoice")!.code;
    const mine = ((await a09.rt.engine.rows("bill")) as Array<{ id: string; number: string }>).filter((b) => b.number.startsWith(`${code}/`)).sort((a, b) => (a.number < b.number ? -1 : 1));
    const last = mine[mine.length - 1];
    if (!last) throw new Error(`the wrong-tax bill was not recorded (${printError})`);
    f.wrongTax = { billId: last.id, number: last.number };
    if (printError) {
      log(`wrong-tax bill ${last.number} recorded; its print failed under the harness's doctored view (${printError}); printing it now`);
      await T.printBill(a09.rt.ctx, last.id);
    }
  });
  await a07.signIn("Meena");
  await step("close shift (blind count)", async () => {
    const shift = a07.rt.data.snapshot().get("shift", shiftId) as never;
    const expected = T.expectedCashFor(list(a07), shift);
    return T.closeShift(a07.rt.ctx, shiftId, expected - 100);
  });
  a08.lan.up = false; // A07 and A08 are now partitioned from each other too
  f.z = await step("close day offline (A07)", () => T.closeDay(a07.rt.ctx));
  clock.minutes(1);
  await a08.signIn("Meena");
  await step("close the same shift on A08 (it never heard of the first close)", () => T.closeShift(a08.rt.ctx, shiftId, 0, { force: true }));
  f.z2 = await step("close the same date on A08, partitioned", () => T.closeDay(a08.rt.ctx));
  // The isolated device bills after the close, still believing the day is open.
  clock.minutes(20);
  await step("late bill on the isolated device", async () => {
    const t = await T.newCounterCheck(a09.rt.ctx);
    await T.addLine(a09.rt.ctx, t, { itemId: "it-meal", qtyMilli: 1000 });
    const b = await pay(a09, t);
    if (b) f.lateBill = { billId: b.billId, number: b.number };
  });
  void bumpAll;
  return f;
}
