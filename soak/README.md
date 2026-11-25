# Phase 2 simulated trading-day soak (ADR-0014 R11, A1.7)

Headless `app-restaurant` devices (counter x3, captain tablet x3, KDS x2) drive a seeded trading day through the real LAN hub
and the real sync gateway on the full Phase 2 local stack, then claims T1 to T13 (plus X1 duplicates, X2 erasure, X3 cloud
restore) are checked against the converged device state, the gateway database and the real `orders` and `billing` services.

```
scripts/stack.sh up                         # infra/dev/up-full.sh on soak ports (SOAK_BILLING_PATCH=1 applies patches/)
scripts/run-one.sh <work> <tag> <seed> <settle|print> <0|1 restore-epoch>
scripts/stack.sh down
python3 scripts/archive.py ...              # writes the run into the test-results repo
```

Layout: `../cmd/soak-onboard` (vendor bootstrap, organisation, owner, devices through the real identity, tenancy and admin),
`gw/` (soakgw: the real svc-sync gateway and hub packages, outbox relay, fault and clock control), `ts/` (device script,
claims, digests), `scripts/`, `patches/`.

## What is real and what is a harness addition

Real: identity, tenancy, admin, catalog, orders, billing, NATS and Postgres processes; the gateway (`service.New`, `api.Mount`)
and the hub (`hub.New`) packages of svc-sync; client-core sync engine; app-restaurant domain code (`runtime`, `data/trading`).

Harness additions, each reported as a finding in the run reports:

1. `soakgw` instead of svc-sync `cmd/gateway`: the stock binary keeps its stub identity and token issuer inside the process, so no
   device can be registered or authenticated; nothing relays its outbox to NATS. soakgw activates the stub directory with the
   device ids and series codes the real identity and tenancy issued, relays the outbox with go-common `outbox.Relay`, applies
   go-common `outbox.RelayStateSchema` (svc-sync has no migration for it), verifies service tokens against the stack's key
   registry, and runs on a clock the driver sets.
2. `ts/vitest.config.ts` rewrites three things in app-restaurant at transform time: the demo tenant and outlet constants, the
   outlet-only stream wiring (three streams in production), and the manual-book codes (`MB1`).
3. Ops are stamped with the proof the stub directory mints (the app's StubIdentity produces none).
4. Configuration is published through legal routes (device config intents; cloud intents emitted by billing with its own key),
   because the app's `seed.demo` op is quarantined as `intent_not_allowed`.
5. `patches/svc-billing-line-claim-body.patch` (optional, through a `go build -overlay`): the as-is svc-billing fails its first bill.
6. `Gateway.ErasePII` is called through a control route because svc-sync exposes no HTTP route for it.

The virtual trading day is yesterday (UTC), 13:05 IST, so that services reading their own wall clock see every op in the past.
