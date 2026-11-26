# Phase 2 simulated trading-day soak (ADR-0014 R11, A1.7)

Headless `app-restaurant` devices (counter x3, captain tablet x3, KDS x2) drive a seeded trading day through the real LAN hub
and the real sync gateway on the full Phase 2 local stack, then claims T1 to T13 (plus X1 duplicates, X2 erasure, X3 cloud
restore) are checked against the converged device state, the gateway database and the real `orders` and `billing` services.

```
scripts/run-all.sh <work> <tag:seed:mode:restore-epoch[:s6-wait-ms]>...   # each run on a FRESH stack: down, up, provision, run
scripts/stack.sh up|down|status|stop|start|restart|rebuild [service]
scripts/run-one.sh <work> <tag> <seed> <settle|print> <0|1>   # one run on a running stack
python3 scripts/archive.py ...                                # writes the run into the test-results repo
```

Run it between 06:00 and 19:30 IST: the devices' virtual clock starts at wall-clock time (see "Clock" below).

Layout: `../cmd/soak-onboard` (vendor bootstrap, organisation, roles, staff with PINs, devices through the real identity, tenancy and
admin), `gw/` (soakgw: internet switch, wall clock, device tokens, epoch), `ts/` (device script, claims, digests), `scripts/`.

## What is real and what is a harness addition

Real: identity, tenancy, admin, catalog, orders, billing, NATS and Postgres processes; **svc-sync's own `cmd/gateway`** with
`SYNC_DIRECTORY=identity` (real identity and tenancy directory, op-signing key, outbox relay to NATS, erasure route); real
device tokens (identity `createDeviceToken`), real PIN proofs verified by identity; the hub (svc-sync `cmd/hub`); client-core
sync engine; app-restaurant (as built, 3b80cb6 in run 6) domain code and runtime, built from the device's offline pack.

Harness additions, each reported in the run reports (the list is also the findings that block a harness-free run):

1. **The LAN hub is svc-sync's own `cmd/hub`** (run 5), run as a process by the driver (`net.ts` `Ctl.hubStart`, SIGKILL for a stop, a new activation for a
   wiped disk). It is activated with an identity-issued hub pack: the owner asks identity for a hub activation code (`soak-onboard -hub-code`),
   `hub activate` redeems it (pack with `peers`, `issuer_env` dev), the `dev` key provider holds the keys (not protection: the hub declares `store:
   unprotected`, and `SYNC_HUB_DEV_PII_LIFT=1` lets it keep customer details anyway so T1 can see where they go). Devices talk to it over TLS 1.3 with the
   node LAN channel (`@hostry/client-core/node`, `LanTransport`: `helloLan`, `openLanSession`, identity-signed credentials from their own packs). Tills
   and tablets are registered with `store: protected`, kitchen screens `unprotected`; the app is built with target `native` (development, any issuer).
   **soakgw is kept only for** the internet switch (two reverse proxies in front of the gateway and identity, for the hub), the wall clock (`GET
   /soak/now`), the devices' bearer tokens (identity `createDeviceToken`) and the restore epoch stamp (`devepoch.Stamp`), plus a read-only look at the hub's
   disk for T1 (row count of `op_pii`; its values are column-encrypted, so the check is that the customer's name is in the clear in no file of the hub).
2. **Native shell stand-in (H1).** Proof keys are derived from the PIN and the pack's salt in `soak-onboard` (Argon2id and HKDF as
   identity does); `net.ts` `HarnessProver` makes identity's real session and approval proofs from what the app hands it (the app builds the
   action hash, target and reason itself). The app's own prover is a fixture.
3. **Pack from identity's claims.** `net.ts` `loadPack` builds the stored view of the device's signed pack (claims plus tenancy's series ids) and the
   app's own `loadVerifiedPack` verifies the JWS and that the view agrees with the signed claims.
4. No build-time rewrite remains (run 4): the app opens the outlet, brand and tenant streams from the pack. `vitest.config.ts` only defines the app's
   build-time constants (browser target; each runtime passes `target: native`).
5. Configuration is published through legal routes (device config intents on the counter; cloud intents emitted by billing with its own key).
6. **No workaround for a product finding remains (run 6).** F26 (`keyprotect.NewDev`, svc-sync c0499fa) and F27 (client-core `LanTransport` re-handshakes on a
   changed hub certificate, a74d521) are fixed upstream: `hub-activate.sh` no longer makes the dev key file and the harness no longer drops any LAN session;
   after every hub start it only observes one sync round per device (`hub_restarts` in the result: rounds failing with "certificate differs" must be 0).
7. The real hub, gateway and identity run on wall time and cannot be set. `Clock.advance` therefore never takes the virtual day more than 5 minutes
   ahead of the wall clock (hours of the script collapse; the hybrid clock's counter still orders operations). **T13's stale blackout ticket needs a ticket
   older than 15 minutes and so cannot be produced** (T6 and T13 fail on that ticket, see the run report). `settle` waits on the wall clock for the hub's
   own timer. The S6 wait (2 min approval window plus 10 min grace on the gateway's own clock) is real time, `SOAK_APPROVAL_WINDOW_MS` (0 = not waited, S6 NOT RUN).

Run 6 additions: the hub is started with `SYNC_HUB_DEV_CLOCK_ADDR=127.0.0.1:<hub port + 1000>` (`Ctl.hubClock`, loopback `/dev/clock`, dev only).
`soakgw` is still used only for the internet switch, the gateway's wall clock (`/soak/now`; S6 still waits real time, nothing in the gateway can be set),
the devices' bearer tokens and the restore epoch. T13/T6 stale ticket: the age of a KOT is judged by the **printing device's own clock** (client-core
`PrintService`, 15 minutes), which neither hub nor cloud sets, so the harness steps the kitchen device's clock forward 25 minutes for the ingest of the
handed-over and stale tickets (`SoakNet.deviceSkew`, no sync and no op in that window) and back for the recent one; the ages are measured and asserted. The hub's
dev clock is exercised separately (`agedHubRounds`): 16 minutes ahead (past its 15-minute LAN session) with every device syncing, then back to wall time.
S7 as built: a cashier re-bills a paid bill without approval and is refused (`approval_needed`); a manager re-bills citing another approver's approval and
billing raises no `rebill_after_payment`. F30: the quarantined duplicate's payments stay in the tender totals and billing raises `payment_unmatched` (warning).

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

The devices' virtual clock starts at wall-clock time and is held at most five minutes ahead of it (run 5; see item 7). Earlier runs let it run
hours ahead because their hub took the virtual time. A device corrects its own clock to the hub's and the cloud's reported time and holds a
last-writer-wins op stamped more than `MAX_FUTURE_MS` (10 minutes) ahead of its clock in clock quarantine; the harness refuses to start outside
06:00 to 19:30 IST so the day stays inside one IST business day (cutoff 05:00). A08 runs seven minutes fast (S4).
