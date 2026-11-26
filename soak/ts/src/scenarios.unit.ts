import { describe, expect, it } from "vitest";
import {
  driveArrival, duplicateDocumentVerdict, emptyScenarioFacts, expectedCreditTaxPaise, fakeApprovalVerdict, lateBeforeCloseVerdict, overCreditVerdict, paymentFirstVerdict, printModeVerdict,
  rebillAfterPaymentVerdict, tenderTotals, zCoverageVerdict, type ArrivalIO, type PresentFact, type ScenarioFacts,
} from "./scenarios";

const A = "0190-device-a";
const B = "0190-device-b";
const fails = (v: { fail: string[] }): string => v.fail.join(" | ");

// ---- M5: the print-mode check can fail for the reason it names ----------------------------------------------------------------------------

const present = (n: number, over: Partial<PresentFact> = {}): PresentFact => ({ checkId: `c${n}`, billId: `b${n}`, number: `AAA/2627/00000${n}`, opIntents: ["bill.finalize"], paymentsAtPresent: 0, ...over });
const printFacts = (n = 2): ScenarioFacts => {
  const s = emptyScenarioFacts();
  s.payCalls = n;
  for (let i = 1; i <= n; i++) s.presents.push(present(i));
  s.staffTotals = { calls: n, opsCreated: 0, billsCreated: 0 };
  return s;
};
const billsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `b${i + 1}`, number: `AAA/2627/00000${i + 1}`, check_id: `c${i + 1}` }));

describe("T12 print mode (M5)", () => {
  it("passes when every payment flow pressed Present and each produced one numbered bill with no payment", () => {
    const v = printModeVerdict(printFacts(), billsOf(2));
    expect(v.ok, fails(v)).toBe(true);
  });
  it("FAILS when the script never pressed Present (the old check passed here: invoices existed and no check_present row)", () => {
    const s = printFacts();
    s.presents = [];
    const v = printModeVerdict(s, billsOf(2));
    expect(v.ok).toBe(false);
    expect(fails(v)).toMatch(/no Present was pressed/);
  });
  it("FAILS when a payment flow did not press Present", () => {
    const s = printFacts(2);
    s.payCalls = 3;
    expect(fails(printModeVerdict(s, billsOf(2)))).toMatch(/3 payment flow\(s\) but 2 Present/);
  });
  it("FAILS when Present finalised twice, or not at all", () => {
    expect(fails(printModeVerdict({ ...printFacts(1), presents: [present(1, { opIntents: ["bill.finalize", "bill.finalize"] })] }, billsOf(1)))).toMatch(/2 bill.finalize/);
    expect(fails(printModeVerdict({ ...printFacts(1), presents: [present(1, { opIntents: [] })] }, billsOf(1)))).toMatch(/0 bill.finalize/);
  });
  it("FAILS when Present finalised with a payment in the same op", () => {
    const v = printModeVerdict({ ...printFacts(1), presents: [present(1, { paymentsAtPresent: 1 })] }, billsOf(1));
    expect(fails(v)).toMatch(/payment in the same op/);
    expect(fails(printModeVerdict({ ...printFacts(1), presents: [present(1, { opIntents: ["bill.finalize", "payment.record"] })] }, billsOf(1)))).toMatch(/recorded a payment op/);
  });
  it("FAILS when the bill of the Present is missing, renumbered or on another check", () => {
    expect(printModeVerdict(printFacts(1), []).ok).toBe(false);
    expect(printModeVerdict(printFacts(1), [{ id: "b1", number: "AAA/2627/000099", check_id: "c1" }]).ok).toBe(false);
    expect(printModeVerdict(printFacts(1), [{ id: "b1", number: "AAA/2627/000001", check_id: "other" }]).ok).toBe(false);
  });
  it("FAILS when a total on a staff screen wrote an op or a bill, and when none was taken", () => {
    expect(fails(printModeVerdict({ ...printFacts(1), staffTotals: { calls: 1, opsCreated: 1, billsCreated: 0 } }, billsOf(1)))).toMatch(/a total finalised/);
    expect(fails(printModeVerdict({ ...printFacts(1), staffTotals: { calls: 1, opsCreated: 0, billsCreated: 1 } }, billsOf(1)))).toMatch(/a total finalised/);
    expect(fails(printModeVerdict({ ...printFacts(1), staffTotals: { calls: 0, opsCreated: 0, billsCreated: 0 } }, billsOf(1)))).toMatch(/was not exercised/);
  });
});

// ---- S1 payment before its bill (H1) -------------------------------------------------------------------------------------------------------

describe("S1 payment arrives before its bill", () => {
  const seeded = (reached: boolean): ScenarioFacts => {
    const s = emptyScenarioFacts();
    s.paymentFirst = { billId: "b1", paymentId: "p2", issuer: "A07", payer: "A08" };
    s.arrival = { planned: [], pushed: [], paymentFirst: { reached, billId: "b1", paymentId: "p2" } };
    return s;
  };
  const dev = [{ tender: "cash", amount_paise: 25200 }, { tender: "upi", amount_paise: 25200 }];
  const report = (cash: number, upi: number, upiCount = 1) => [{ tender: "cash", payment_count: 1, paid: { amount_paise: cash } }, { tender: "upi", payment_count: upiCount, paid: { amount_paise: upi } }];
  it("passes when the order was reached and every tender is counted once", () => {
    expect(paymentFirstVerdict(seeded(true), dev, report(25200, 25200), 50400, 50400).ok).toBe(true);
  });
  it("FAILS on the double count the review measured (100,800 against 50,400)", () => {
    const v = paymentFirstVerdict(seeded(true), dev, report(50400, 50400, 2), 100800, 50400);
    expect(v.ok).toBe(false);
    expect(fails(v)).toMatch(/counted more than once/);
  });
  it("FAILS when the order was not reached (a pass would prove nothing)", () => {
    const v = paymentFirstVerdict(seeded(false), dev, report(25200, 25200), 50400, 50400);
    expect(fails(v)).toMatch(/not evidenced/);
  });
  it("FAILS when the scenario was not seeded", () => {
    expect(paymentFirstVerdict(emptyScenarioFacts(), dev, report(25200, 25200), 0, 0).ok).toBe(false);
  });
  it("passes when the payment's payment_unmatched was cleared at its bill's arrival, FAILS when it is still open or another one is", () => {
    const cleared = { ofThisPayment: [{ kind: "payment_unmatched", subject_id: "p2", status: "resolved" }], openElsewhere: 0 };
    expect(paymentFirstVerdict(seeded(true), dev, report(25200, 25200), 50400, 50400, cleared).ok).toBe(true);
    const stuck = { ofThisPayment: [{ kind: "payment_unmatched", subject_id: "p2", status: "open" }], openElsewhere: 0 };
    expect(fails(paymentFirstVerdict(seeded(true), dev, report(25200, 25200), 50400, 50400, stuck))).toMatch(/still open although its bill arrived/);
    expect(fails(paymentFirstVerdict(seeded(true), dev, report(25200, 25200), 50400, 50400, { ofThisPayment: [], openElsewhere: 2 }))).toMatch(/2 payment_unmatched/);
  });
  it("totals tenders per name", () => {
    expect(tenderTotals([...dev, { tender: "cash", amount_paise: 100 }])).toEqual({ cash: { paise: 25300, count: 2 }, upi: { paise: 25200, count: 1 } });
  });
});

// ---- S2 cumulative over-credit (H2) --------------------------------------------------------------------------------------------------------

describe("S2 two tills credit the same bill", () => {
  const s = emptyScenarioFacts();
  s.doubleCredit = { billId: "b1", billTotalPaise: 50400, billTaxPaise: 2400, notes: [{ number: "N/1", totalPaise: 50400 }, { number: "N/2", totalPaise: 50400 }], devices: ["A07", "A08"] };
  const flagged = [{ kind: "credit_exceeds_bill", subject_id: "n2", subject_kind: "credit_note", status: "open" }];
  it("passes when the over-credit is flagged and the tax is reduced once", () => {
    expect(overCreditVerdict(s, ["n1", "n2"], flagged, { reportedPaise: 2400, expectedPaise: 2400, notesInDay: 2 }).ok).toBe(true);
  });
  it("FAILS with no exception (the review's probe: credited 100800, exceptions [])", () => {
    expect(fails(overCreditVerdict(s, ["n1", "n2"], [], { reportedPaise: 2400, expectedPaise: 2400, notesInDay: 2 }))).toMatch(/no open over-credit exception/);
  });
  it("FAILS when the exception is about another bill or already resolved", () => {
    expect(overCreditVerdict(s, ["n1", "n2"], [{ kind: "credit_exceeds_bill", subject_id: "zzz", status: "open" }], { reportedPaise: 2400, expectedPaise: 2400, notesInDay: 2 }).ok).toBe(false);
    expect(overCreditVerdict(s, ["n1", "n2"], [{ ...flagged[0]!, status: "resolved" }], { reportedPaise: 2400, expectedPaise: 2400, notesInDay: 2 }).ok).toBe(false);
  });
  it("FAILS when output tax is reduced twice", () => {
    const v = overCreditVerdict(s, ["n1", "n2"], flagged, { reportedPaise: 4800, expectedPaise: 2400, notesInDay: 2 });
    expect(fails(v)).toMatch(/reduced more than once/);
  });
  it("FAILS when the notes do not actually over-credit, and when not seeded", () => {
    const one = emptyScenarioFacts();
    one.doubleCredit = { ...s.doubleCredit!, notes: [{ number: "N/1", totalPaise: 50400 }] };
    expect(overCreditVerdict(one, ["n1"], flagged, { reportedPaise: 2400, expectedPaise: 2400, notesInDay: 1 }).ok).toBe(false);
    expect(overCreditVerdict(emptyScenarioFacts(), [], flagged, { reportedPaise: 0, expectedPaise: 0, notesInDay: 0 }).ok).toBe(false);
  });
  it("the expected credit tax counts a bill's tax once however many full notes it has, and a partial note pro rata", () => {
    const bills = [{ id: "b1", total_paise: 50400, tax_paise: 2400 }, { id: "b2", total_paise: 10000, tax_paise: 500 }, { id: "b3", total_paise: 1000, tax_paise: 50 }];
    const notes = [{ bill_id: "b1", total_paise: 50400 }, { bill_id: "b1", total_paise: 50400 }, { bill_id: "b2", total_paise: 5000 }, { bill_id: "gone", total_paise: 99 }];
    expect(expectedCreditTaxPaise(bills, notes)).toBe(2400 + 250);
  });
});

// ---- S3 late bill before the day close (H3) and S4 fast clock (H4) -------------------------------------------------------------------------

const rev = (origin: string, from: number, to: number, total = 0) => ({ origin_device_id: origin, op_from_seq: from, op_to_seq: to, cause: "late_device", added_totals: { total: { amount_paise: total } } });

describe("S3 late bill arrives before the day close", () => {
  const seeded = (reached: boolean, closed: boolean): ScenarioFacts => {
    const s = emptyScenarioFacts();
    s.lateOps = [{ origin: A, seq: 30, billId: "late1" }, { origin: A, seq: 41, billId: "late2" }];
    s.arrival = { planned: [], pushed: [], lateBeforeClose: { reached, billIds: ["late1", "late2"], dayClosedAtThatTime: closed } };
    return s;
  };
  it("passes when each late op is in exactly one revision of its origin", () => {
    expect(lateBeforeCloseVerdict(seeded(true, false), [rev(A, 25, 45)]).ok).toBe(true);
    expect(lateBeforeCloseVerdict(seeded(true, false), [rev(A, 25, 35), rev(A, 36, 45)]).ok).toBe(true);
  });
  it("FAILS with no revision (the review's probe b: late_document_count 0)", () => {
    expect(fails(lateBeforeCloseVerdict(seeded(true, false), []))).toMatch(/in 0 Z revision/);
  });
  it("FAILS when two revisions both cover one op, or the revision belongs to another origin", () => {
    expect(fails(lateBeforeCloseVerdict(seeded(true, false), [rev(A, 25, 45), rev(A, 30, 31)]))).toMatch(/in 2 Z revision/);
    expect(lateBeforeCloseVerdict(seeded(true, false), [rev(B, 25, 45)]).ok).toBe(false);
  });
  it("FAILS when the arrival order was not reached or a day was already closed (not evidenced)", () => {
    expect(fails(lateBeforeCloseVerdict(seeded(false, false), [rev(A, 25, 45)]))).toMatch(/not evidenced/);
    expect(fails(lateBeforeCloseVerdict(seeded(true, true), [rev(A, 25, 45)]))).toMatch(/not evidenced/);
    expect(lateBeforeCloseVerdict({ ...seeded(true, false), arrival: undefined }, [rev(A, 25, 45)]).ok).toBe(false);
  });
  it("FAILS when no late op was recorded", () => {
    expect(lateBeforeCloseVerdict({ ...seeded(true, false), lateOps: [] }, []).ok).toBe(false);
  });
});

describe("S4 device with a fast clock", () => {
  const seeded = (over: Partial<NonNullable<ScenarioFacts["fastClock"]>> = {}): ScenarioFacts => {
    const s = emptyScenarioFacts();
    s.fastClock = { billId: "f1", op: { origin: B, seq: 12 }, offsetMs: 420_000, atMs: 1_420_000, closeMs: 1_000_000, heldByCloser: true, ...over };
    return s;
  };
  const sums = { zTotalPaise: 1000, revisionTotalPaise: 200, allBillsPaise: 1200 };
  it("passes when no revision covers the bill and Z plus revisions equals every bill", () => {
    expect(zCoverageVerdict(seeded(), [rev(A, 1, 9, 200)], sums).ok).toBe(true);
    expect(zCoverageVerdict(seeded(), [rev(B, 20, 30, 200)], sums).ok).toBe(true); // same origin, other ops
  });
  it("FAILS when a revision covers the bill the Z already holds (the review's probe a: late=true)", () => {
    const v = zCoverageVerdict(seeded(), [rev(B, 10, 14, 200)], sums);
    expect(fails(v)).toMatch(/counted twice/);
  });
  it("FAILS when Z plus revisions differs from the bills", () => {
    expect(zCoverageVerdict(seeded(), [], { zTotalPaise: 1000, revisionTotalPaise: 500, allBillsPaise: 1200 }).ok).toBe(false);
  });
  it("FAILS when the closer did not hold the bill, or the clock skew did not put the bill after the cutoff (not evidenced)", () => {
    expect(fails(zCoverageVerdict(seeded({ heldByCloser: false }), [], sums))).toMatch(/not evidenced/);
    expect(fails(zCoverageVerdict(seeded({ atMs: 900_000 }), [], sums))).toMatch(/skew was not exercised/);
  });
  it("FAILS when the bill was not made", () => {
    expect(zCoverageVerdict(emptyScenarioFacts(), [], sums).ok).toBe(false);
  });
});

// ---- S5 duplicate document (H5) ------------------------------------------------------------------------------------------------------------

describe("S5 duplicate invoice number", () => {
  const s = emptyScenarioFacts();
  s.dupNumber = { number: "AAA/2627/000042", firstBillId: "b1", secondBillId: "b2", secondOp: { origin: A, seq: 50 } };
  const refused = [{ status: "quarantined", reason: "duplicate_document", marks: "" }];
  const unmatched = { kind: "payment_unmatched", subject_id: "pay2-xxxxxxxx", status: "open", severity: "warning" };
  const b = (over: Record<string, unknown>) => ({ bills: [{ id: "b1", number: "AAA/2627/000042" }], exceptions: [unmatched], secondBillPaymentIds: ["pay2-xxxxxxxx"], paymentsSeparate: true, billingPaymentsOfSecondBill: 1, ...over }) as Parameters<typeof duplicateDocumentVerdict>[2];
  it("passes when the gateway refuses the second op, billing keeps the number with the first bill and warns about the orphaned payment", () => {
    const v = duplicateDocumentVerdict(s, refused, b({}));
    expect(v.ok, fails(v)).toBe(true);
  });
  it("passes when billing holds both bills but reports a duplicate exception", () => {
    const v = duplicateDocumentVerdict(s, refused, b({ bills: [{ id: "b1", number: "AAA/2627/000042" }, { id: "b2", number: "AAA/2627/000042" }], exceptions: [unmatched, { kind: "duplicate_number", status: "open" }] }));
    expect(v.ok, fails(v)).toBe(true);
  });
  it("FAILS when the gateway accepted the second op silently (the review's finding)", () => {
    const v = duplicateDocumentVerdict(s, [{ status: "accepted", reason: "", marks: "" }], b({}));
    expect(fails(v)).toMatch(/did not refuse the second op as duplicate_document/);
    expect(duplicateDocumentVerdict(s, [{ status: "accepted", reason: "duplicate_document", marks: "" }], b({})).ok).toBe(false);
  });
  it("FAILS when billing holds both bills with no exception, or the second bill holds the number", () => {
    expect(duplicateDocumentVerdict(s, refused, b({ bills: [{ id: "b1", number: "AAA/2627/000042" }, { id: "b2", number: "AAA/2627/000042" }] })).ok).toBe(false);
    expect(duplicateDocumentVerdict(s, refused, b({ bills: [{ id: "b2", number: "AAA/2627/000042" }] })).ok).toBe(false);
  });
  it("FAILS when the gateway holds no row, and when not seeded", () => {
    expect(fails(duplicateDocumentVerdict(s, [], b({})))).toMatch(/holds no row/);
    expect(duplicateDocumentVerdict(emptyScenarioFacts(), [], b({ bills: [], exceptions: [] })).ok).toBe(false);
  });
  it("FAILS when the orphaned payment has no payment_unmatched, a closed one, or a severity other than warning (F30)", () => {
    expect(fails(duplicateDocumentVerdict(s, refused, b({ exceptions: [] })))).toMatch(/0 payment_unmatched/);
    expect(duplicateDocumentVerdict(s, refused, b({ exceptions: [{ ...unmatched, status: "resolved" }] })).ok).toBe(false);
    expect(duplicateDocumentVerdict(s, refused, b({ exceptions: [{ ...unmatched, severity: "high" }] })).ok).toBe(false);
    expect(duplicateDocumentVerdict(s, refused, b({ exceptions: [{ ...unmatched, subject_id: "other" }] })).ok).toBe(false);
  });
  it("settle mode: the payments are inside the quarantined op, billing holds none and no exception is needed; FAILS if billing holds one", () => {
    const m = { paymentsSeparate: false, billingPaymentsOfSecondBill: 0, exceptions: [] };
    expect(duplicateDocumentVerdict(s, refused, b(m)).ok).toBe(true);
    expect(duplicateDocumentVerdict(s, refused, b({ ...m, billingPaymentsOfSecondBill: 1 })).ok).toBe(false);
  });
  it("FAILS when the second bill carries no payment (the check would be vacuous)", () => {
    expect(fails(duplicateDocumentVerdict(s, refused, b({ secondBillPaymentIds: [], exceptions: [] })))).toMatch(/not evidenced/);
  });
});

// ---- S6 approval that does not exist (P2-H1) -----------------------------------------------------------------------------------------------

describe("S6 override citing a non-existent approval", () => {
  const s = emptyScenarioFacts();
  s.fakeApproval = { approvalId: "ap-nobody", intent: "bill.line.comp", op: { origin: A, seq: 7 } };
  it("passes when the op is flagged approval_flag with reason missing", () => {
    const v = fakeApprovalVerdict(s, [{ status: "flagged", reason: "", marks: "approval_flag,approval_reason:missing" }]);
    expect(v.ok, fails(v)).toBe(true);
  });
  it("FAILS when it is accepted unflagged and still pending after the window (the review's finding)", () => {
    const v = fakeApprovalVerdict(s, [{ status: "accepted", reason: "", marks: "approval_pending" }]);
    expect(v.ok).toBe(false);
    expect(fails(v)).toMatch(/accepted unflagged/);
    expect(fails(v)).toMatch(/still approval_pending/);
  });
  it("FAILS on another reason, and when the gateway holds no row or the scenario was not seeded", () => {
    expect(fakeApprovalVerdict(s, [{ status: "flagged", reason: "", marks: "approval_flag,approval_reason:expired" }]).ok).toBe(false);
    expect(fakeApprovalVerdict(s, []).ok).toBe(false);
    expect(fakeApprovalVerdict(emptyScenarioFacts(), []).ok).toBe(false);
  });
});

// ---- S7 re-bill after payment (P2-H2) ------------------------------------------------------------------------------------------------------

describe("S7 re-bill after payment: cashier refused, manager with another approver's approval accepted", () => {
  const made = (over: Partial<NonNullable<ScenarioFacts["rebillPaid"]>>): ScenarioFacts => {
    const s = emptyScenarioFacts();
    s.rebillPaid = {
      billId: "b1",
      paymentsOnBill: 1,
      cashier: { outcome: "refused", code: "approval_needed" },
      approved: { approver: "Anand", requester: "Meena", creditNumber: "CN/1", replacementNumbers: ["AAA/2627/000009"] },
      ...over,
    };
    return s;
  };
  const arrived = { credit: true, replacements: 1 };
  it("passes: the cashier is refused for the missing approval, the approved re-bill arrived and billing raised nothing", () => {
    const v = rebillAfterPaymentVerdict(made({}), [{ kind: "late_document", subject_id: "b1", status: "open" }], ["b1", "cn1"], arrived);
    expect(v.ok, fails(v)).toBe(true);
  });
  it("FAILS when the device let the cashier re-bill a paid bill without an approval (F29 returns)", () => {
    expect(fails(rebillAfterPaymentVerdict(made({ cashier: { outcome: "done" } }), [], ["b1"], arrived))).toMatch(/let a cashier re-bill/);
  });
  it("FAILS when the cashier was refused for another reason (a missing permission does not show the rule)", () => {
    expect(rebillAfterPaymentVerdict(made({ cashier: { outcome: "refused", code: "PermissionError" } }), [], ["b1"], arrived).ok).toBe(false);
  });
  it("FAILS when billing raises rebill_after_payment for the re-bill that cited an approval", () => {
    const v = rebillAfterPaymentVerdict(made({}), [{ kind: "rebill_after_payment", subject_id: "cn1", subject_kind: "credit_note", status: "open" }], ["b1", "cn1"], arrived);
    expect(fails(v)).toMatch(/raised 1 rebill_after_payment/);
  });
  it("ignores a rebill_after_payment on an unrelated subject", () => {
    expect(rebillAfterPaymentVerdict(made({}), [{ kind: "rebill_after_payment", subject_id: "other", status: "open" }], ["b1"], arrived).ok).toBe(true);
  });
  it("FAILS when billing never saw the re-bill (an absent exception would mean nothing)", () => {
    expect(fails(rebillAfterPaymentVerdict(made({}), [], ["b1"], { credit: false, replacements: 0 }))).toMatch(/did not arrive/);
  });
  it("FAILS when the manager's approved re-bill did not complete, the approver is the requester, the bill had no payment, or nothing was attempted", () => {
    expect(fails(rebillAfterPaymentVerdict(made({ approved: undefined }), [], ["b1"], arrived))).toMatch(/did not complete/);
    expect(rebillAfterPaymentVerdict(made({ approved: { approver: "Meena", requester: "Meena", creditNumber: "CN/1", replacementNumbers: ["x"] } }), [], ["b1"], arrived).ok).toBe(false);
    expect(rebillAfterPaymentVerdict(made({ paymentsOnBill: 0 }), [], ["b1"], arrived).ok).toBe(false);
    expect(rebillAfterPaymentVerdict(emptyScenarioFacts(), [], [], arrived).ok).toBe(false);
  });
});

// ---- arrival order -------------------------------------------------------------------------------------------------------------------------

describe("driveArrival", () => {
  /** A fake cloud: billing learns each device's bills and payments when it pushes. */
  const world = (opts: { brokenPush?: string; neverProjects?: boolean } = {}) => {
    const log: string[] = [];
    const bills = new Set<string>();
    const pays = new Set<string>();
    let closed = false;
    const holds: Record<string, () => void> = {
      A09: () => ["late1", "late2"].forEach((b) => bills.add(b)),
      A08: () => pays.add("p2"),
      A07: () => {
        bills.add("b1");
        closed = true;
      },
    };
    const io: ArrivalIO = {
      async pushDirect(d) {
        log.push(`push ${d}`);
        if (d === opts.brokenPush) throw new Error("no route");
        if (!opts.neverProjects) holds[d]?.();
      },
      billingHasBill: async (id) => bills.has(id),
      billingHasPayment: async (id) => pays.has(id),
      dayClosed: async () => closed,
      until: async (c) => c(),
    };
    return { io, log };
  };
  const facts = (): ScenarioFacts => {
    const s = emptyScenarioFacts();
    s.paymentFirst = { billId: "b1", paymentId: "p2", issuer: "A07", payer: "A08" };
    return s;
  };
  const plan = { late: { device: "A09", billIds: ["late1", "late2"] }, payer: "A08", closer: "A07" };

  it("pushes the late device, then the payer, then the closer, and observes both preconditions", async () => {
    const w = world();
    const a = await driveArrival(w.io, facts(), plan);
    expect(w.log).toEqual(["push A09", "push A08", "push A07"]);
    expect(a.lateBeforeClose).toEqual({ reached: true, billIds: ["late1", "late2"], dayClosedAtThatTime: false });
    expect(a.paymentFirst).toEqual({ reached: true, billId: "b1", paymentId: "p2" });
  });
  it("records an unreached precondition instead of assuming it (billing never projects)", async () => {
    const a = await driveArrival(world({ neverProjects: true }).io, facts(), plan);
    expect(a.lateBeforeClose?.reached).toBe(false);
    expect(a.paymentFirst?.reached).toBe(false);
  });
  it("records a push that failed, and leaves that precondition absent", async () => {
    const a = await driveArrival(world({ brokenPush: "A09" }).io, facts(), plan);
    expect(a.pushed[0]).toMatchObject({ device: "A09", ok: false, detail: "no route" });
    expect(a.lateBeforeClose).toBeUndefined();
  });
  it("is not reached when there is no late bill to wait for", async () => {
    const a = await driveArrival(world().io, facts(), { ...plan, late: { device: "A09", billIds: [] } });
    expect(a.lateBeforeClose?.reached).toBe(false);
  });
  it("feeds the verdicts: an unreached order fails S1 and S3 as 'not evidenced'", async () => {
    const s = facts();
    s.lateOps = [{ origin: A, seq: 30, billId: "late1" }];
    s.arrival = await driveArrival(world({ neverProjects: true }).io, s, plan);
    expect(fails(lateBeforeCloseVerdict(s, [rev(A, 1, 99)]))).toMatch(/not evidenced/);
    expect(fails(paymentFirstVerdict(s, [], [], 0, 0))).toMatch(/not evidenced/);
  });
});
