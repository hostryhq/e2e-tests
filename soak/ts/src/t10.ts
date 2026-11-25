import { execFileSync } from "node:child_process";
import { FEATURE, adoptEntitlements, featureOn, parseEntitlements, tradingStanding, type EntitlementSnapshot } from "../../../../app-restaurant/src/domain/entitlements";
import type { Dev, SoakNet } from "./net";
import type { Svc } from "./svc";

/**
 * T10 (ADR-0014 R11): trading is never gated by entitlements or billing state. What is driven, all through the real services:
 *  - the onboarding puts the organisation on a plan WITH the kitchen screen (`soak_full`) and raises a charge for a long-past period, so the
 *    subscription is overdue (a billing state) for the whole trading day;
 *  - every device holds the pack's `entitlements` snapshot from the morning and trades offline all day;
 *  - mid-day the vendor changes the plan to one WITHOUT `restaurant.kds` (`soak_lite`): the real tenancy raises entitlements_v, the real identity
 *    puts the higher snapshot in the next pack; the devices are offline and must keep what they hold;
 *  - at reconnect each device refreshes its pack and adopts the higher snapshot; a stale pack never lowers it; the kitchen screens then find
 *    `restaurant.kds` absent with the internet cut again (the decision is local);
 *  - suspension and closure apply only after the trading day (A1.2): the app's own `tradingStanding` on the adopted snapshot with a
 *    suspended status (synthetic: the vendor suspension flow needs an approval and is refused while a day is open) and the devices' real day state.
 */
export type DevSnap = { v: number | undefined; status: string | undefined; plan: string | undefined; kds: boolean; captain: boolean; features: string[] };
export type T10State = {
  overdueAtOnboarding: boolean;
  morning: Record<string, DevSnap>;
  mid?: { vendorChange: string; heldWhileOffline: Record<string, DevSnap> };
  reconnect?: {
    refresh: Record<string, { fetched: number; before: DevSnap; adopted: boolean; after: DevSnap }>;
    stale: Record<string, { adopted: boolean; v: number | undefined }>;
    offlineAfterAdopt: Record<string, DevSnap>;
    malformedAdopted: boolean;
  };
  standing?: {
    daysOpenAtEnd: string[];
    dayInProgress: { startNew: boolean; ending: boolean };
    afterTheDay: { startNew: boolean };
    absentSnapshot: { startNew: boolean };
    closedAfterTheDay: { startNew: boolean };
  };
  error?: string;
};

const snapOf = (d: Dev): DevSnap => {
  const e = d.rt.entitlements();
  return { v: e?.entitlements_v, status: e?.organisation_status, plan: e?.plan_key, kds: featureOn(e, FEATURE.kds), captain: featureOn(e, FEATURE.captain), features: e?.features ?? [] };
};
const all = (net: SoakNet): Record<string, DevSnap> => Object.fromEntries([...net.devs.entries()].map(([n, d]) => [n, snapOf(d)]));

export const newT10 = (overdueAtOnboarding: boolean): T10State => ({ overdueAtOnboarding, morning: {} });

/** The devices' snapshots as the packs gave them (call right after the cast is built). */
export function t10Morning(net: SoakNet, st: T10State): void {
  st.morning = all(net);
}

/** Mid-day, internet cut: the vendor changes the plan; the devices must not notice. */
export async function t10Mid(net: SoakNet, svc: Svc, st: T10State, tenant: string): Promise<void> {
  try {
    // No owner sign-in here: identity rate-limits OTP sign-ins per address and the onboarding has used the allowance for now. The vendor
    // acts through its own session (password and TOTP). The device-side effect is read at the reconnect, when the pack is refreshed.
    const bin = process.env.SOAK_ONBOARD_BIN ?? "/tmp/hostry-soak/soak-onboard";
    const out = execFileSync(bin, ["-vendor-state", process.env.SOAK_VENDOR_STATE ?? "/tmp/hostry-soak/vendor-state.json", "-change-plan", "soak_lite", "-org", tenant], { timeout: 120_000 }).toString();
    const sub = JSON.parse(out) as { plan_key?: string; overdue?: boolean };
    st.mid = { vendorChange: `${sub.plan_key ?? "?"} overdue=${sub.overdue}`, heldWhileOffline: all(net) };
  } catch (e) {
    st.error = `mid-day: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** After the reconnect: refresh every pack, adopt, re-offer the old pack, then decide offline again. */
export async function t10Reconnect(net: SoakNet, svc: Svc, st: T10State, nowMs: number): Promise<void> {
  try {
    await svc.login();
    const refresh: NonNullable<T10State["reconnect"]>["refresh"] = {};
    const stale: NonNullable<T10State["reconnect"]>["stale"] = {};
    for (const [name, d] of net.devs) {
      const before = snapOf(d);
      let r = await svc.identity(`/v1/devices/${d.fx.device_id}/offline-packs/latest`);
      // identity learns of the change over NATS or asks tenancy live: give it a moment before calling the refresh stale.
      for (let k = 0; k < 20 && parseEntitlements(r.json?.claims?.entitlements)?.plan_key !== "soak_lite"; k++) {
        await new Promise((x) => setTimeout(x, 1000));
        r = await svc.identity(`/v1/devices/${d.fx.device_id}/offline-packs/latest`);
      }
      const adopted = d.rt.adoptPack({ entitlements: r.json?.claims?.entitlements });
      refresh[name] = { fetched: r.status, before, adopted, after: snapOf(d) };
    }
    // The morning pack arrives again (an old copy, a replayed sync): the higher version stays.
    for (const [name, d] of net.devs) {
      const old = (d.fx.pack as { entitlements?: unknown }).entitlements;
      const adopted = d.rt.adoptPack({ entitlements: old });
      stale[name] = { adopted, v: d.rt.entitlements()?.entitlements_v };
    }
    const malformedAdopted = net.dev("K9K").rt.adoptPack({ entitlements: { entitlements_v: 99, features: "all" } });
    await net.setInternet(false); // the decision below reads the held snapshot only
    const offlineAfterAdopt = all(net);
    await net.setInternet(true);
    st.reconnect = { refresh, stale, offlineAfterAdopt, malformedAdopted };

    // Suspension and closure: only after the trading day. The device's real business-day rows decide whether a day is in progress.
    const a07 = net.dev("A07");
    const days = a07.rt.data.snapshot().list<{ business_date: string; status: string }>("business_day");
    const open = days.filter((x) => x.status === "open").map((x) => x.business_date);
    const held = a07.rt.entitlements()!;
    const suspended: EntitlementSnapshot = { ...held, organisation_status: "suspended" };
    const closed: EntitlementSnapshot = { ...held, organisation_status: "closed" };
    const today = new Date(nowMs + 330 * 60_000).toISOString().slice(0, 10);
    const inProgress = tradingStanding(suspended, [today], nowMs);
    st.standing = {
      daysOpenAtEnd: open,
      dayInProgress: { startNew: inProgress.startNew, ending: inProgress.startNew ? inProgress.ending : false },
      afterTheDay: { startNew: tradingStanding(suspended, open, nowMs).startNew },
      absentSnapshot: { startNew: tradingStanding(undefined, [], nowMs).startNew },
      closedAfterTheDay: { startNew: tradingStanding(closed, open, nowMs).startNew },
    };
    void adoptEntitlements;
  } catch (e) {
    st.error = `reconnect: ${e instanceof Error ? e.message : String(e)}`;
  }
}
