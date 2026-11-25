# Phase 2 simulated trading-day soak (ADR-0014 R11, A1.7)

Headless `app-restaurant` devices (counter x3, captain tablet x3, KDS x2) drive a seeded trading day through the real LAN hub
and the real sync gateway on the full Phase 2 local stack, then claims T1 to T13 (plus X1 duplicates, X2 erasure, X3 cloud
restore) are checked against the converged device state, the gateway database and the real `orders` and `billing` services.

```
scripts/run-all.sh <work> <tag:seed:mode:restore-epoch>...   # each run on a FRESH stack: down, up, provision, run
scripts/stack.sh up|down|status|stop|start|restart|rebuild [service]
scripts/run-one.sh <work> <tag> <seed> <settle|print> <0|1>   # one run on a running stack
python3 scripts/archive.py ...                                # writes the run into the test-results repo
```

Run it between 06:00 and 19:30 IST: the devices' virtual clock starts at wall-clock time (see "Clock" below).

Layout: `../cmd/soak-onboard` (vendor bootstrap, organisation, roles, staff with PINs, devices through the real identity, tenancy and
admin), `gw/` (soakgw: the LAN hub, device tokens, clock and internet switch), `ts/` (device script, claims, digests), `scripts/`.

## What is real and what is a harness addition

Real: identity, tenancy, admin, catalog, orders, billing, NATS and Postgres processes; **svc-sync's own `cmd/gateway`** with
`SYNC_DIRECTORY=identity` (real identity and tenancy directory, op-signing key, outbox relay to NATS, erasure route); real
device tokens (identity `createDeviceToken`), real PIN proofs verified by identity; the hub (`hub.New`) of svc-sync; client-core
sync engine; app-restaurant e2ed513 domain code and runtime, built from the device's offline pack.

Harness additions, each reported in the run reports (the list is also the findings that block a harness-free run):

1. **soakgw** still hosts the LAN hub, because the hub has no pack source against the real directory (cmd/hub reads a pack file that
   only the stub directory's dev route produces) and the LAN trust root is an identity signature over each credential that real
   identity does not produce. soakgw signs the credentials with a throw-away LAN key, takes device keys and series from the onboarding,
   mints device tokens, and holds the virtual clock of the hub and the internet switch.
2. **Native shell stand-in (H1).** Proof keys are derived from the PIN and the pack's salt in `soak-onboard` (Argon2id and HKDF as
   identity does); `net.ts` `HarnessProver` makes identity's real session and approval proofs from what the app hands it (the app builds the
   action hash, target and reason itself). The app's own prover is a fixture.
3. **Pack from identity's claims.** `net.ts` `packOf` maps the signed offline pack claims plus tenancy's series ids to the app's `DevicePack`
   (no adapter exists yet).
4. No build-time rewrite remains (run 4): the app opens the outlet, brand and tenant streams from the pack.
5. Configuration is published through legal routes (device config intents on the counter; cloud intents emitted by billing with its own key).
6. soakgw `GET /soak/hub/pii` reads the hub's `op_pii` table (read-only) so T1 can check that the hub holds the customer's values.
7. After a cloud restore the engine re-offers its pii-bearing ops on every round for a day (svc-sync `ResendPII`), so `settle` stops counting hub pushes as
   progress once `net.piiResend` is set (vectors and pulls must still be quiet).

T10 (run 4): `soak-onboard` creates two plans (`soak_full` with `restaurant.kds`, `soak_lite` without), puts the organisation on `soak_full`
with a charge for a long-past period (overdue), and `-change-plan soak_lite -org <id>` changes the plan as the vendor does mid-day (`ts/src/t10.ts`).
The packs carry identity's `entitlements` snapshot; at the reconnect each device refreshes its pack and the runtime's `adoptPack` takes the higher snapshot.
Suspension and closure statuses are synthetic (the vendor suspension needs an approval and is refused while a day is open); the app's own
`tradingStanding` decides against the devices' real day rows. The headless devices do not render the UI, so "kitchen mode unavailable" is the
app's `featureOn(snapshot, restaurant.kds)` decision, not a screen.

Removed in run 3 (the products now do it): the `SchemaRegistry` patch and `engine.record` wrapper for `session` and `approval` records, the invented
approval hash, `SOAK_NO_SESSION_RECORD`, the brand overlay (`SOAK_SYNC_PATCH`), the cashier's override permissions (`SOAK_CASHIER_STRICT`), the
`known_tenants` insert, and the manual KDS session (the KDS calls the app's `openDeviceSession`).

## Clock

The devices' virtual clock starts at wall-clock time and runs forward (a day of ten virtual hours takes about three minutes). The real
gateway stamps cloud-origin ops with its own clock, and a device holds a last-writer-wins op stamped more than `MAX_FUTURE_MS` ahead of its
clock in clock quarantine; with the devices a day behind (the earlier scheme) the outlet's tax profile and numbering settings never applied.
Virtual time ahead of the gateway is accepted by the gateway except for last-writer-wins configuration ops more than 10 minutes ahead
(`clock_review`), which the script does not send during the day.

## Why a fresh stack per run

Identity caps OTP sends per client address at 40 a day (a run signs in five times), and a poison event on the bus (finding F14) would block the
next run's consumers.

## Review scenarios S1 to S7 and the self-test (after the Phase 2 reviews)

The first four runs never created these orderings and faults (code review H1 to H5, M5, M7; security review P2-H1, P2-H2). Seeded per run from its own
random stream (`seed ^ 0x5c3a`), recorded in `facts.scn`, judged by `ts/src/scenario-claims.ts` with the pure verdicts of `ts/src/scenarios.ts`:

| Claim | Scenario | Passes only when |
|---|---|---|
| S1 (H1) | a payment recorded on A08 for A07's bill reaches billing first (scripted direct pushes, `driveArrival`) | the order was observed and billing's tender summary equals the devices' per tender |
| S2 (H2) | A07 and A08, partitioned, each credit one bill in full | an open over-credit exception exists and the tax summary reduces output tax once |
| S3 (H3) | A09's late bills reach billing before any day close | each lies in exactly one revision of its origin |
| S4 (H4) | B5K (clock 7 min fast) bills, A07 holds it, then closes | no revision covers it, Z plus revisions equals all bills |
| S5 (H5) | A09's counter goes back one and it bills again: one number, two bill ids | the gateway refuses `duplicate_document`, the first bill keeps the number in billing |
| S6 (P2-H1) | a cashier comps citing an approval nobody granted | after the window the op is `flagged`, `approval_flag`, reason `missing` |
| S7 (P2-H2) | a paid bill is re-billed without approval | refused on the device (`refused`/`approval_needed`) or flagged by a re-bill exception in billing |

A precondition that was not reached (order, skew, partition) fails the claim as "not evidenced"; a scenario that was not seeded never passes.
The seeded duplicate (S5) is left out of the generic totals, number and print checks (T2, T3, T6, T11), which expect it to be refused or flagged.
The exception kind names `credit_exceeds_bill`, `rebill*` and `duplicate*` are the reviews' proposals, matched by pattern (`OVER_CREDIT`, `REBILL_DETECTOR`): adjust them when the services settle on names.
T12 in print mode (M5) now also needs `printModeVerdict`: Present pressed for every payment flow, exactly one `bill.finalize` and no payment per Present, and a total on a staff screen that wrote no op or bill.

Self-test, no stack and no fixture: `cd ts && npm run selftest` (synthetic data; every verdict has a passing case and the failing cases of the reviews, including a Present that was never pressed).
`npm run typecheck` reports only errors that predate these files (day.ts casts, net.ts `OUTLET_STREAM`).
