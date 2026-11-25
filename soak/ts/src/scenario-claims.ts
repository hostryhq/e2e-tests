import { mk, type Claim, type Inputs } from "./claims";
import { psql } from "./svc";
import {
  duplicateDocumentVerdict, expectedCreditTaxPaise, fakeApprovalVerdict, lateBeforeCloseVerdict, overCreditVerdict, paymentFirstVerdict, rebillAfterPaymentVerdict, zCoverageVerdict,
  type GatewayOpRow, type OpRef, type Verdict,
} from "./scenarios";

type R = Record<string, any>;
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

const asClaim = (id: string, name: string, v: Verdict, note?: string): Claim => {
  const t = mk(id, name);
  for (const p of v.pass) t.ok(true, p, "");
  for (const f of v.fail) t.ok(false, "", f);
  if (note) t.note(note);
  return t.c;
};

const gatewayRows = (tenant: string, op: OpRef): GatewayOpRow[] =>
  psql("sync", `select status, coalesce(reason,''), marks from ops where tenant_id='${tenant}' and origin='${op.origin}' and seq=${op.seq}`).map(([status, reason, marks]) => ({ status: status!, reason: reason ?? "", marks: marks ?? "" }));

/**
 * S1 to S7: the scenarios the first four soak runs never exercised (code review H1-H5, security review P2-H1, P2-H2). Each claim fails when its
 * scenario was not seeded or its precondition (arrival order, clock skew, partition) was not reached: it is never passed by default.
 */
export async function scenarioClaims(i: Inputs): Promise<Claim[]> {
  const { net, facts: f, svc, date, tenant } = i;
  const s = f.scn;
  const a07 = net.dev("A07");
  const rows = async (e: string): Promise<R[]> => (await a07.rt.engine.rows(e)) as R[];
  const dupId = s.dupNumber?.secondBillId; // the seeded duplicate stays out of the generic totals; S5 judges it
  const bills = (await rows("bill")).filter((b) => b.id !== dupId);
  const notes = await rows("credit_note");
  const pays = (await rows("payment")).filter((p) => p.bill_id !== dupId);
  const sBills = await svc.all("billing", "/v1/bills");
  const sNotes = await svc.all("billing", "/v1/credit-notes");
  const sPays = await svc.all("billing", "/v1/payments");
  const bExc = await svc.all("billing", "/v1/exceptions");
  const days = await svc.all("billing", "/v1/business-days");
  const day = days.find((d) => d.business_date === date);
  const revisions: R[] = day ? await svc.all("billing", `/v1/business-days/${day.id}/revisions`) : [];
  const tender = await svc.all("billing", `/v1/reports/tender-summary?from=${date}&to=${date}`);
  const tax = await svc.all("billing", `/v1/reports/tax-summary?from=${date}&to=${date}`);
  const out: Claim[] = [];

  // S1 (H1)
  {
    const pf = s.paymentFirst;
    const ofBill = (xs: R[], k: (x: R) => number): number => sum(xs.filter((x) => x.bill_id === pf?.billId).map(k));
    out.push(
      asClaim(
        "S1",
        "Payment arrives before its bill",
        paymentFirstVerdict(
          s,
          pays.map((p) => ({ tender: p.tender, amount_paise: Number(p.amount_paise) })),
          tender as never,
          ofBill(sPays, (p) => p.amount.amount_paise),
          ofBill(pays, (p) => Number(p.amount_paise)),
        ),
      ),
    );
  }

  // S2 (H2)
  {
    const reported = sum(tax.map((x) => Number(x.credit_cgst?.amount_paise ?? 0) + Number(x.credit_sgst?.amount_paise ?? 0)));
    const expected = expectedCreditTaxPaise(
      bills.map((b) => ({ id: b.id, total_paise: Number(b.total_paise), tax_paise: Number(b.cgst_paise ?? 0) + Number(b.sgst_paise ?? 0) })),
      notes.map((n) => ({ bill_id: n.bill_id, total_paise: Number(n.total_paise) })),
    );
    const noteIds = sNotes.filter((n) => n.bill_id === s.doubleCredit?.billId).map((n) => n.id as string);
    out.push(asClaim("S2", "Two tills credit the same bill", overCreditVerdict(s, noteIds, bExc, { reportedPaise: reported, expectedPaise: expected, notesInDay: notes.length })));
  }

  // S3 (H3)
  out.push(asClaim("S3", "Late bill arrives before the day close", lateBeforeCloseVerdict(s, revisions as never), `arrival: ${JSON.stringify(s.arrival)}; billing day ${day?.status}, late_document_count ${day?.late_document_count}, revisions ${revisions.length}`));

  // S4 (H4)
  {
    const revTotal = sum(revisions.map((r) => Number(r.added_totals?.total?.amount_paise ?? 0)));
    out.push(asClaim("S4", "Fast-clock device, Z coverage by vector", zCoverageVerdict(s, revisions as never, { zTotalPaise: f.z?.totalPaise ?? NaN, revisionTotalPaise: revTotal, allBillsPaise: sum(bills.map((b) => Number(b.total_paise))) })));
  }

  // S5 (H5)
  {
    const d = s.dupNumber;
    out.push(asClaim("S5", "Duplicate invoice number under two bill ids", duplicateDocumentVerdict(s, d ? gatewayRows(tenant, d.secondOp) : [], { bills: sBills.map((b) => ({ id: b.id, number: b.number })), exceptions: bExc })));
  }

  // S6 (P2-H1): wait out the window on the gateway's clock, then look at the op.
  {
    const fa = s.fakeApproval;
    let rowsOf: GatewayOpRow[] = [];
    if (fa) {
      net.clock.advance(10 * 60_000);
      await net.ctl.clock(net.clock.ms);
      const end = Date.now() + Number(process.env.SOAK_APPROVAL_WINDOW_MS ?? 120_000);
      for (;;) {
        rowsOf = gatewayRows(tenant, fa.op);
        if (rowsOf.some((r) => r.marks.includes("approval_flag")) || Date.now() > end) break;
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
    out.push(asClaim("S6", "Override citing a non-existent approval", fakeApprovalVerdict(s, rowsOf)));
  }

  // S7 (P2-H2)
  {
    const r = s.rebillPaid;
    const ids = [
      r?.billId,
      ...(r?.creditNumber ? sNotes.filter((n) => n.number === r.creditNumber).map((n) => n.id as string) : []),
      ...(r?.replacementNumbers ?? []).flatMap((num) => sBills.filter((b) => b.number === num).map((b) => b.id as string)),
    ].filter((x): x is string => !!x);
    out.push(asClaim("S7", "Re-bill after payment without approval", rebillAfterPaymentVerdict(s, bExc, ids)));
  }
  return out;
}
