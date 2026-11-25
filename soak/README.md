# Phase 2 simulated trading-day soak (ADR-0014 R11, A1.7)

Headless `app-restaurant` devices (counter x3, captain tablet x3, KDS x2) drive a seeded trading day through the real LAN hub
and the real sync gateway on the full Phase 2 local stack, then claims T1 to T13 (plus X1 duplicates, X2 erasure, X3 cloud
restore) are checked against the converged device state, the gateway database and the real `orders` and `billing` services.

```
scripts/run-all.sh <work> <tag:seed:mode:restore-epoch>...   # each run on a FRESH stack: down, up, provision, run (SOAK_SYNC_PATCH=1 by default)
scripts/stack.sh up|down|status|stop|start|restart|rebuild [service]
scripts/run-one.sh <work> <tag> <seed> <settle|print> <0|1>   # one run on a running stack
python3 scripts/archive.py ...                                # writes the run into the test-results repo
```

Run it between 06:00 and 19:30 IST: the devices' virtual clock starts at wall-clock time (see "Clock" below).

Layout: `../cmd/soak-onboard` (vendor bootstrap, organisation, roles, staff with PINs, devices through the real identity, tenancy and
admin), `gw/` (soakgw: the LAN hub, device tokens, clock and internet switch), `ts/` (device script, claims, digests), `scripts/`, `patches/`.

## What is real and what is a harness addition

Real: identity, tenancy, admin, catalog, orders, billing, NATS and Postgres processes; **svc-sync's own `cmd/gateway`** with
`SYNC_DIRECTORY=identity` (real identity and tenancy directory, op-signing key, outbox relay to NATS, erasure route); real
device tokens (identity `createDeviceToken`), real PIN proofs verified by identity; the hub (`hub.New`) of svc-sync; client-core
sync engine; app-restaurant 09bf2db domain code and runtime, built from the device's offline pack.

Harness additions, each reported in the run reports (the list is also the findings that block a harness-free run):

1. **soakgw** still hosts the LAN hub, because the hub has no pack source against the real directory (cmd/hub reads a pack file that
   only the stub directory's dev route produces) and the LAN trust root is an identity signature over each credential that real
   identity does not produce. soakgw signs the credentials with a throw-away LAN key, takes device keys and series from the onboarding,
   mints device tokens, and holds the virtual clock of the hub and the internet switch.
2. **Native shell stand-in (H1).** Proof keys are derived from the PIN and the pack's salt in `soak-onboard` (Argon2id and HKDF as
   identity does); `net.ts` `HarnessProver` makes identity's real session and approval proofs. The app's own prover is a fixture.
3. **Pack from identity's claims.** `net.ts` `packOf` maps the signed offline pack claims plus tenancy's series ids to the app's `DevicePack`
   (no adapter exists yet).
4. **`session` and `approval` records.** The gateway types a session from the `session` record of `session.open` and verifies an approval from the
   `approval` record of `approval.grant`; app-restaurant records neither and client-core's registry has no such entities (the harness registers
   them as append entities and adds the records; `SOAK_NO_SESSION_RECORD=1` runs without). A KDS gets a `session.open` of type `device`.
5. **Brand binding overlay** (`patches/svc-sync-credential-brand.patch`, `SOAK_SYNC_PATCH=1`, a `go build -overlay`, the checkout is not touched):
   identity's credential has no `brand_id`, so the real directory refuses every brand-stream op as `stream_outside_binding`.
6. **Cashier role holds the two override permissions** (`bill.discount.over_limit`, `bill.line.comp`): the gateway flags an override intent
   `permission_flag` although an approval stands behind it, and every `sync.op.flagged` event blocks the orders and billing consumers.
7. **billing `known_tenants`**: registered by SQL (billing cannot subscribe to `tenancy.organisation.created`; `SOAK_NO_KNOWN_TENANT=1` runs without).
8. One build-time rewrite remains in `ts/vitest.config.ts`: the app opens the engine on the outlet stream only; the three streams are named from the onboarding.
9. Configuration is published through legal routes (device config intents on the counter; cloud intents emitted by billing with its own key).

## Clock

The devices' virtual clock starts at wall-clock time and runs forward (a day of ten virtual hours takes about three minutes). The real
gateway stamps cloud-origin ops with its own clock, and a device holds a last-writer-wins op stamped more than `MAX_FUTURE_MS` ahead of its
clock in clock quarantine; with the devices a day behind (the earlier scheme) the outlet's tax profile and numbering settings never applied.
Virtual time ahead of the gateway is accepted by the gateway except for last-writer-wins configuration ops more than 10 minutes ahead
(`clock_review`), which the script does not send during the day.

## Why a fresh stack per run

Identity caps OTP sends per client address at 40 a day (a run signs in five times), and a poison event on the bus (finding F14) would block the
next run's consumers.
