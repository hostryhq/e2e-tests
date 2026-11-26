/**
 * Phase 2 review scenarios the soak never exercised (code review H1-H5, M5, M7; security review P2-H1, P2-H2).
 *
 * This file is PURE: facts the script recorded and rows read from the services go in, a verdict comes out. It imports no device code and no
 * network code, so every assertion has a unit test with synthetic data (`scenarios.unit.ts`), including a negative case for each: an assertion
 * that cannot fail is not evidence (M5). The script that creates the scenarios is `scenario-steps.ts`; the claims that apply these verdicts to a
 * run are `scenario-claims.ts`.
 */

export type OpRef = { origin: string; seq: number };

export type Verdict = { ok: boolean; pass: string[]; fail: string[] };

function verdict(): { v: Verdict; check(cond: boolean, pass: string, fail: string): boolean } {
  const v: Verdict = { ok: true, pass: [], fail: [] };
  return {
    v,
    check(cond, pass, fail) {
      if (cond) v.pass.push(pass);
      else {
        v.fail.push(fail);
        v.ok = false;
      }
      return cond;
    },
  };
}

// ---- facts the script records -------------------------------------------------------------------------------------------------------------

/** One Present pressed in a `print` outlet, observed on the device right after the call (M5). */
export type PresentFact = {
  checkId: string;
  billId: string;
  number: string;
  /** Intents of the ops the device recorded during the Present call, in order. */
  opIntents: string[];
  /** Payment rows the device held for the bill right after Present, before any payment was recorded. */
  paymentsAtPresent: number;
};

/** What the script's own staff-screen totals (previewCheck) did to the device: nothing may be written or numbered. */
export type StaffTotals = { calls: number; opsCreated: number; billsCreated: number };

/** How the cloud saw the arrival order the script forced (scripted direct pushes, one device at a time). */
export type Arrival = {
  planned: string[];
  pushed: Array<{ device: string; ok: boolean; detail?: string }>;
  /** S1: the payment was projected by billing while its bill was still absent. */
  paymentFirst?: { reached: boolean; billId: string; paymentId: string };
  /** S3: the late bills were projected before any business day close arrived. */
  lateBeforeClose?: { reached: boolean; billIds: string[]; dayClosedAtThatTime: boolean };
};

export type ScenarioFacts = {
  /** Print mode: every pay() call, and the Presents it pressed. */
  payCalls: number;
  presents: PresentFact[];
  staffTotals: StaffTotals;
  /** S1: a payment recorded on a device other than the bill's issuer, offline from it. */
  paymentFirst?: { billId: string; paymentId: string; issuer: string; payer: string };
  /** S2: two tills that could not hear each other each credit the same bill in full. */
  doubleCredit?: { billId: string; billTotalPaise: number; billTaxPaise: number; notes: Array<{ number: string; totalPaise: number }>; devices: string[] };
  /** S3: the finalize ops of the isolated device (outside the Z's vector). */
  lateOps: Array<OpRef & { billId: string }>;
  /** S4: a bill from a device whose clock is fast, held by the closing device before the close. */
  fastClock?: { billId: string; op: OpRef; offsetMs: number; atMs: number; closeMs: number; heldByCloser: boolean };
  /** S5: one legal number under two bill ids. */
  dupNumber?: { number: string; firstBillId: string; secondBillId: string; secondOp: OpRef };
  /** S6: an override citing an approval nobody granted. */
  fakeApproval?: { approvalId: string; intent: string; op: OpRef; billId?: string };
  /** S7: re-bill of a bill that already carries a payment, without approval. */
  rebillPaid?: {
    billId: string;
    paymentsOnBill: number;
    /** The cashier's attempt without an approval. */
    cashier: { outcome: "refused" | "done"; code?: string };
    /** The manager's re-bill citing another approver's approval (as built: any re-bill of a paid bill cites one, F29). */
    approved?: { approver: string; requester: string; creditNumber: string; replacementNumbers: string[] };
  };
  arrival?: Arrival;
};

export const emptyScenarioFacts = (): ScenarioFacts => ({ payCalls: 0, presents: [], staffTotals: { calls: 0, opsCreated: 0, billsCreated: 0 }, lateOps: [] });

// ---- rows read from the services ----------------------------------------------------------------------------------------------------------

export type ExceptionRow = { kind: string; subject_id?: string; subject_kind?: string; status?: string; severity?: string };
export type RevisionRow = { origin_device_id: string; op_from_seq: number; op_to_seq: number; cause?: string; added_totals?: { total?: { amount_paise?: number }; bill_count?: number } };
export type GatewayOpRow = { status: string; reason: string; marks: string };

const covers = (r: RevisionRow, op: OpRef): boolean => r.origin_device_id === op.origin && r.op_from_seq <= op.seq && op.seq <= r.op_to_seq;
const open = (e: ExceptionRow): boolean => (e.status ?? "open") === "open";

// ---- M5: the print-mode numbering trigger -------------------------------------------------------------------------------------------------

/**
 * ADR-0014 A1.5: in an outlet set to print, Present IS the finalisation. Evidence required (each can fail for the reason it names):
 * the script pressed Present at least once and for every pay call; each Present produced exactly one numbered bill for its check, with
 * exactly one `bill.finalize` op and no payment (payment comes after); and a total on a staff screen never wrote an op or a bill.
 */
export function printModeVerdict(s: ScenarioFacts, bills: Array<{ id: string; number: string; check_id?: string }>): Verdict {
  const { v, check } = verdict();
  check(s.presents.length > 0, `${s.presents.length} Present(s) were pressed in print mode`, "no Present was pressed in print mode: the numbering trigger was not exercised");
  check(s.presents.length === s.payCalls, `every one of the ${s.payCalls} payment flows pressed Present first`, `${s.payCalls} payment flow(s) but ${s.presents.length} Present(s) recorded`);
  for (const p of s.presents) {
    const finalizes = p.opIntents.filter((i) => i === "bill.finalize").length;
    check(finalizes === 1, `Present on ${p.number} recorded exactly one bill.finalize`, `Present on check ${p.checkId} recorded ${finalizes} bill.finalize op(s): ${JSON.stringify(p.opIntents)}`);
    check(p.opIntents.every((i) => !/payment/.test(i)), `Present on ${p.number} recorded no payment op`, `Present on ${p.number} recorded a payment op: ${JSON.stringify(p.opIntents)}`);
    check(p.paymentsAtPresent === 0, `no payment existed on ${p.number} right after Present`, `${p.paymentsAtPresent} payment(s) existed on ${p.number} right after Present: it finalised with a payment in the same op`);
    const rows = bills.filter((b) => b.id === p.billId);
    check(rows.length === 1 && rows[0]!.number === p.number && rows[0]!.check_id === p.checkId, `${p.number} is the one bill of its check`, `bill ${p.billId} for check ${p.checkId} is ${JSON.stringify(rows.map((r) => [r.number, r.check_id]))}, Present returned ${p.number}`);
  }
  const t = s.staffTotals;
  check(t.calls > 0, `${t.calls} staff-screen total(s) were taken`, "no staff-screen total was taken: 'a total never finalises' was not exercised");
  check(t.opsCreated === 0 && t.billsCreated === 0, "taking a total on a staff screen wrote no op and no bill", `staff-screen totals wrote ${t.opsCreated} op(s) and ${t.billsCreated} bill(s): a total finalised`);
  return v;
}

// ---- S1: payment before its bill (H1) -----------------------------------------------------------------------------------------------------

export type TenderRow = { tender: string; amount_paise: number };
export type TenderSummaryItem = { tender: string; payment_count: number; paid: { amount_paise: number }; refunded?: { amount_paise: number } };

/** The per-tender totals of a list of payments, as `{ tender: { paise, count } }`. */
export function tenderTotals(rows: TenderRow[]): Record<string, { paise: number; count: number }> {
  const m: Record<string, { paise: number; count: number }> = {};
  for (const r of rows) {
    const e = (m[r.tender] ??= { paise: 0, count: 0 });
    e.paise += r.amount_paise;
    e.count++;
  }
  return m;
}

/**
 * The payment reached billing before its bill and the tender totals still equal the devices' (counted once). The report is billing's own
 * tender summary, which is what the owner reads; the stored payments of the bill are compared as well.
 */
export function paymentFirstVerdict(a: ScenarioFacts, devicePayments: TenderRow[], report: TenderSummaryItem[], servicePaymentsOfBill: number, devicePaymentsOfBill: number): Verdict {
  const { v, check } = verdict();
  const pf = a.arrival?.paymentFirst;
  check(!!a.paymentFirst, "the script made a payment on a device other than the bill's issuer", "the payment-from-another-device scenario was not seeded (script step failed)");
  check(!!pf?.reached, "billing projected the payment while its bill was still absent (arrival order forced)", `the order was not reached: ${pf ? "the payment never arrived first" : "no arrival record"}; the scenario is not evidenced`);
  const dev = tenderTotals(devicePayments);
  const cloud = Object.fromEntries(report.map((r) => [r.tender, { paise: r.paid.amount_paise, count: r.payment_count }]));
  const names = [...new Set([...Object.keys(dev), ...Object.keys(cloud)])].sort();
  for (const n of names) {
    const d = dev[n] ?? { paise: 0, count: 0 };
    const c = cloud[n] ?? { paise: 0, count: 0 };
    check(d.paise === c.paise && d.count === c.count, `tender ${n}: ${d.paise} paise in ${d.count} payment(s) on both sides`, `tender ${n}: devices ${d.paise}/${d.count}, billing report ${c.paise}/${c.count}: a payment is counted ${c.paise > d.paise ? "more than once" : "less than once"}`);
  }
  check(servicePaymentsOfBill === devicePaymentsOfBill, `the bill's payments total ${devicePaymentsOfBill} paise on both sides`, `the bill's payments: devices ${devicePaymentsOfBill}, billing ${servicePaymentsOfBill}`);
  return v;
}

// ---- S2: cumulative over-credit (H2) ------------------------------------------------------------------------------------------------------

/** The exception kinds svc-billing emits (api-specs-p2 17de74f): matched exactly, no longer by pattern. */
export const BILLING_EXCEPTION_KINDS = [
  "credit_exceeds_bill", "duplicate_number", "rebill_after_payment", "rebill_allowance_exceeded", "rebill_value_reduced",
  "rebill_value_reduction_over_allowance", "rebill_value_reduction_repeated", "comp_allowance_exceeded",
] as const;
export const OVER_CREDIT = /^credit_exceeds_bill$/;

/**
 * Output tax the credit notes may take off: per bill, its tax times the credited share (capped at the whole bill). Two full notes on one bill
 * reduce the tax once. Notes of a bill absent from `bills` are ignored.
 */
export function expectedCreditTaxPaise(bills: Array<{ id: string; total_paise: number; tax_paise: number }>, notes: Array<{ bill_id: string; total_paise: number }>): number {
  let sum = 0;
  for (const b of bills) {
    const credited = notes.filter((n) => n.bill_id === b.id).reduce((a, n) => a + n.total_paise, 0);
    if (credited === 0 || b.total_paise <= 0) continue;
    sum += Math.round((b.tax_paise * Math.min(credited, b.total_paise)) / b.total_paise);
  }
  return sum;
}

export function overCreditVerdict(s: ScenarioFacts, noteIds: string[], exceptions: ExceptionRow[], creditTax: { reportedPaise: number; expectedPaise: number; notesInDay: number }): Verdict {
  const { v, check } = verdict();
  const d = s.doubleCredit;
  if (!check(!!d, "two tills each credited the same bill", "the double credit was not seeded (script step failed)")) return v;
  const credited = d!.notes.reduce((a, n) => a + n.totalPaise, 0);
  check(d!.notes.length >= 2 && credited > d!.billTotalPaise, `bill ${d!.billId.slice(0, 8)} (${d!.billTotalPaise} paise) was credited ${credited} paise by ${d!.notes.length} notes`, `the notes do not over-credit: ${credited} paise against ${d!.billTotalPaise}`);
  const subjects = new Set([d!.billId, ...noteIds]);
  const flagged = exceptions.filter((e) => OVER_CREDIT.test(e.kind) && open(e) && e.subject_id !== undefined && subjects.has(e.subject_id));
  check(flagged.length >= 1, `the over-credit is flagged: ${flagged.map((e) => e.kind).join(", ")}`, `no open over-credit exception for the bill or its notes (kinds seen: ${[...new Set(exceptions.map((e) => e.kind))].join(", ") || "none"})`);
  const tol = Math.max(1, creditTax.notesInDay);
  check(Math.abs(creditTax.reportedPaise - creditTax.expectedPaise) <= tol, `output tax reduced once: credit tax ${creditTax.reportedPaise} paise (expected ${creditTax.expectedPaise}, tolerance ${tol})`, `credit tax in billing's tax summary is ${creditTax.reportedPaise} paise, a bill may be credited once: expected ${creditTax.expectedPaise} (tolerance ${tol}); output tax is reduced more than once`);
  return v;
}

// ---- S3 and S4: Z coverage (H3, H4) -------------------------------------------------------------------------------------------------------

/**
 * A late document that reached billing before the day close is still in a Z revision, once: every finalize op of the isolated device lies in
 * exactly one revision of its origin.
 */
export function lateBeforeCloseVerdict(s: ScenarioFacts, revisions: RevisionRow[]): Verdict {
  const { v, check } = verdict();
  const lb = s.arrival?.lateBeforeClose;
  check(!!lb?.reached && lb.dayClosedAtThatTime === false, `the late bill(s) were projected before any close arrived (${lb?.billIds.length ?? 0})`, `the late bill was not projected before the close (${lb ? `reached=${lb.reached}, day already closed=${lb.dayClosedAtThatTime}` : "no arrival record"}): the scenario is not evidenced`);
  check(s.lateOps.length > 0, `${s.lateOps.length} finalize op(s) of the isolated device are outside the Z`, "no finalize op of the isolated device was recorded");
  for (const op of s.lateOps) {
    const n = revisions.filter((r) => covers(r, op)).length;
    check(n === 1, `late bill ${op.billId.slice(0, 8)} (op ${op.seq}) is in exactly one revision`, `late bill ${op.billId} (origin ${op.origin.slice(-6)}, op ${op.seq}) is in ${n} Z revision(s), expected 1`);
  }
  return v;
}

/**
 * A device with a fast clock issued a bill the closing device held at the close: the Z covers it by version vector, whatever its `at` says,
 * so no revision covers it, and Z plus revisions equals every bill (no double count).
 */
export function zCoverageVerdict(s: ScenarioFacts, revisions: RevisionRow[], sums: { zTotalPaise: number; revisionTotalPaise: number; allBillsPaise: number }): Verdict {
  const { v, check } = verdict();
  const f = s.fastClock;
  if (!check(!!f, "a bill was issued on the fast-clock device", "the fast-clock bill was not made (script step failed)")) return v;
  check(f!.heldByCloser, "the closing device held that bill's op before it closed", "the closing device did not hold the bill's op at the close: it is outside the vector by construction, the scenario is not evidenced");
  check(f!.atMs > f!.closeMs, `the bill's own time is ${Math.round((f!.atMs - f!.closeMs) / 60_000)} min after the close time of the closing device`, `the bill's time is not after the close time (${f!.atMs} <= ${f!.closeMs}): the clock skew was not exercised`);
  const n = revisions.filter((r) => covers(r, f!.op)).length;
  check(n === 0, "no Z revision covers the fast-clock bill (the Z holds it, by vector)", `the fast-clock bill (op ${f!.op.seq}) is in ${n} Z revision(s) as well as in the Z: counted twice`);
  check(sums.zTotalPaise + sums.revisionTotalPaise === sums.allBillsPaise, `original Z plus revisions equals all bills (${sums.allBillsPaise})`, `Z ${sums.zTotalPaise} + revisions ${sums.revisionTotalPaise} != all bills ${sums.allBillsPaise}`);
  return v;
}

// ---- S5: duplicate document (H5) ----------------------------------------------------------------------------------------------------------

/**
 * The same number under a second bill id is refused as `duplicate_document` at the gateway, the first op keeps the number in billing; if
 * billing nevertheless holds both, it must say so with a duplicate exception.
 */
export function duplicateDocumentVerdict(s: ScenarioFacts, gatewayRowsOfSecondOp: GatewayOpRow[], billing: { bills: Array<{ id: string; number: string }>; exceptions: ExceptionRow[]; secondBillPaymentIds: string[] }): Verdict {
  const { v, check } = verdict();
  const d = s.dupNumber;
  if (!check(!!d, "the same number was issued under two bill ids", "the duplicate number was not seeded (script step failed)")) return v;
  const refused = gatewayRowsOfSecondOp.filter((r) => /duplicate_document/.test(`${r.reason} ${r.marks}`));
  check(refused.length >= 1 && refused.every((r) => r.status !== "accepted"), `the gateway refused the second op as duplicate_document (${refused[0]?.status})`, gatewayRowsOfSecondOp.length === 0 ? "the gateway holds no row of the second op" : `the gateway did not refuse the second op as duplicate_document: ${JSON.stringify(gatewayRowsOfSecondOp)}`);
  const holders = billing.bills.filter((b) => b.number === d!.number);
  const ids = holders.map((b) => b.id);
  const dupExc = billing.exceptions.filter((e) => /^duplicate_number$/.test(e.kind) && open(e));
  const firstKeeps = ids.length === 1 && ids[0] === d!.firstBillId;
  const bothButSaid = ids.length === 2 && ids.includes(d!.firstBillId) && ids.includes(d!.secondBillId) && dupExc.length >= 1;
  check(firstKeeps || bothButSaid, firstKeeps ? "billing kept the number with the first bill only" : "billing holds both bills and reports a duplicate exception", `billing holds ${ids.length} bill(s) with ${d!.number} (${JSON.stringify(ids.map((i) => (i === d!.firstBillId ? "first" : i === d!.secondBillId ? "second" : "other")))}) and ${dupExc.length} duplicate exception(s)`);
  // F30 / O2-22: the quarantined bill's payments still reach billing. The money stays in the tender totals (the claims no longer exclude it) and billing
  // says so: `payment_unmatched`, severity warning, open, on each such payment.
  check(billing.secondBillPaymentIds.length > 0, `${billing.secondBillPaymentIds.length} payment(s) were recorded on the second bill`, "the second bill carries no payment: the payment_unmatched check is not evidenced");
  for (const pid of billing.secondBillPaymentIds) {
    const un = billing.exceptions.filter((e) => e.kind === "payment_unmatched" && e.subject_id === pid);
    check(un.length === 1 && open(un[0]!) && un[0]!.severity === "warning", `payment ${pid.slice(0, 8)} of the quarantined bill carries one open payment_unmatched (warning)`, `payment ${pid.slice(0, 8)} of the quarantined bill: ${un.length} payment_unmatched exception(s) ${JSON.stringify(un.map((e) => [e.status, e.severity]))}, expected one open warning`);
  }
  return v;
}

// ---- S6: an override citing an approval that does not exist (P2-H1) -----------------------------------------------------------------------

/** After the window the citing op is `flagged` with `approval_flag` and reason `missing`; it is no longer pending. */
export function fakeApprovalVerdict(s: ScenarioFacts, gatewayRows: GatewayOpRow[]): Verdict {
  const { v, check } = verdict();
  const f = s.fakeApproval;
  if (!check(!!f, "a cashier cited an approval nobody granted", "the fake-approval override was not seeded (script step failed)")) return v;
  const r = gatewayRows[0];
  if (!check(!!r, "the gateway holds the op", "the gateway holds no row of the citing op")) return v;
  const marks = r!.marks.split(",").map((m) => m.trim());
  check(marks.includes("approval_flag") && marks.includes("approval_reason:missing"), `the op is marked approval_flag, reason missing (${r!.status})`, `the op ${r!.status === "accepted" ? "is accepted unflagged" : "is not flagged missing"} after the window: status ${r!.status}, marks ${JSON.stringify(r!.marks)}`);
  check(r!.status === "flagged", "its status is flagged: it reaches the owner's exceptions list", `its status is ${r!.status}, not flagged`);
  check(!marks.includes("approval_pending"), "it is no longer pending", "it is still approval_pending after the window");
  return v;
}

// ---- S7: re-bill after payment (P2-H2, F29) ----------------------------------------------------------------------------------------------

/** Device refusals that name the rule (a re-bill of a paid bill needs an approval); a missing permission does not count. */
export const REBILL_REFUSAL_CODES = ["approval_needed"];
/** Ruling 8: a re-bill of a bill that carries a payment without a cited approval is `rebill_after_payment`. */
export const REBILL_DETECTOR = /^rebill_after_payment$/;

/**
 * As built (app-restaurant 3b80cb6): a re-bill of a bill that carries a payment always cites an approval, even from a manager. A cashier without one is
 * refused on the device; a manager citing another approver's approval is accepted by billing without `rebill_after_payment`. `known` says how much of the
 * re-bill billing projected (the absence of the exception means nothing if billing never saw the group).
 */
export function rebillAfterPaymentVerdict(s: ScenarioFacts, exceptions: ExceptionRow[], subjectIds: string[], known: { credit: boolean; replacements: number }): Verdict {
  const { v, check } = verdict();
  const r = s.rebillPaid;
  if (!check(!!r, "a cashier attempted a re-bill of a paid bill without approval", "the re-bill after payment was not attempted (script step failed)")) return v;
  check(r!.paymentsOnBill > 0, `the bill carried ${r!.paymentsOnBill} payment(s)`, "the bill had no payment: the scenario is not evidenced");
  check(r!.cashier.outcome === "refused" && REBILL_REFUSAL_CODES.includes(r!.cashier.code ?? ""), `the cashier was refused on the device (${r!.cashier.code})`, r!.cashier.outcome === "done" ? "the device let a cashier re-bill a paid bill without an approval" : `the device refused it for another reason (${r!.cashier.code}), not for the missing approval`);
  const a = r!.approved;
  if (!check(!!a, `a manager re-billed it citing ${a?.approver ?? "another approver"}'s approval`, "the manager's re-bill with a cited approval did not complete (script step failed)")) return v;
  check(a!.approver !== a!.requester, `the approval came from another approver than the requester (${a!.approver} for ${a!.requester})`, "the approver is the requester");
  check(known.credit && known.replacements === a!.replacementNumbers.length && a!.replacementNumbers.length > 0, `billing holds the credit note and ${known.replacements} replacement bill(s) of the re-bill`, `billing holds ${known.credit ? "the" : "no"} credit note and ${known.replacements} of ${a!.replacementNumbers.length} replacement bill(s): the re-bill did not arrive, so the absence of an exception is not evidence`);
  const ids = new Set(subjectIds);
  const found = exceptions.filter((e) => REBILL_DETECTOR.test(e.kind) && e.subject_id !== undefined && ids.has(e.subject_id));
  check(found.length === 0, "billing raised no rebill_after_payment for the approved re-bill", `billing raised ${found.length} rebill_after_payment exception(s) although the re-bill cited an approval: ${JSON.stringify(found.map((e) => [e.subject_kind, e.status]))}`);
  return v;
}

// ---- arrival order ------------------------------------------------------------------------------------------------------------------------

/** What `driveArrival` needs from the outside world; faked in the unit tests. */
export type ArrivalIO = {
  /** The device reaches the cloud directly (its LAN cut, its internet up) and pushes its own ops. Throws when it cannot. */
  pushDirect(device: string): Promise<void>;
  billingHasBill(id: string): Promise<boolean>;
  billingHasPayment(id: string): Promise<boolean>;
  /** True once billing holds a closed (or revised) business day. */
  dayClosed(): Promise<boolean>;
  /** Polls `cond` until true or the budget is spent. */
  until(cond: () => Promise<boolean>): Promise<boolean>;
};

/**
 * The order the script forces at reconnect, before the hub relays the rest: the isolated device first (its late bills reach billing before
 * any close, S3), then the counter that recorded the payment (the payment reaches billing before its bill, S1), then the issuer and closer.
 * Every precondition is observed, not assumed; an unreached one is recorded as such and the claim fails.
 */
export async function driveArrival(io: ArrivalIO, s: ScenarioFacts, plan: { late: { device: string; billIds: string[] }; payer: string; closer: string }): Promise<Arrival> {
  const arrival: Arrival = { planned: [plan.late.device, plan.payer, plan.closer], pushed: [] };
  const push = async (device: string): Promise<boolean> => {
    try {
      await io.pushDirect(device);
      arrival.pushed.push({ device, ok: true });
      return true;
    } catch (e) {
      arrival.pushed.push({ device, ok: false, detail: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };
  if (await push(plan.late.device)) {
    const seen = await io.until(async () => (await Promise.all(plan.late.billIds.map((id) => io.billingHasBill(id)))).every(Boolean));
    arrival.lateBeforeClose = { reached: seen && plan.late.billIds.length > 0, billIds: plan.late.billIds, dayClosedAtThatTime: await io.dayClosed() };
  }
  const pf = s.paymentFirst;
  if (await push(plan.payer)) {
    if (pf) {
      const paid = await io.until(() => io.billingHasPayment(pf.paymentId));
      arrival.paymentFirst = { reached: paid && !(await io.billingHasBill(pf.billId)), billId: pf.billId, paymentId: pf.paymentId };
    }
  }
  await push(plan.closer);
  return arrival;
}
