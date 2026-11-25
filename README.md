# e2e-tests

Cross-service end-to-end suite. It starts the real services as local processes against the infra dev
stack (compose project `e2e`, Postgres on 55500; services on 18101 identity, 18102 tenancy, 18103 admin)
and stops everything again. No live third party is contacted.

| Scenario | File | What it proves |
|---|---|---|
| 1 | `e2e/scenario1_test.go`, `scenario1b_test.go` | `svc-identity vendor bootstrap` CLI, vendor sign-in through svc-admin (cookie, CSRF, Origin), organisation + outlet + owner invite in one onboarding (one Idempotency-Key, replay returns the same organisation), owner OTP login, GSTIN verification by a vendor user, device registration, offline pack carrying the series tenancy issued |
| 2 | `e2e/scenario2_test.go` | tenant B gets 404 for every tenant A resource it can name (tenancy and identity), lists do not leak, controls on B's own resources succeed |
| 3 | `e2e/scenario3_test.go` | two-person approval: refused with fewer than two eligible users, requester cannot self-approve, an approver older than 7 days approves with a fresh TOTP |
| load | `e2e/zz_load_test.go` | LOCAL load baseline (not production shape), `E2E_LOAD=1` |

`scripts/run-all.sh <out-dir> [soak]` runs everything in order (build, scenarios + load, client-core
sync e2e against the svc-sync devstack, simulator seed 1 and 50 seeds, soak) and writes raw logs.
`scripts/build.sh` builds the services from the committed HEAD of each repo and records the SHAs.

Known workarounds: the identity binary's test SMS sender discards the code, so the test reads the
challenge's keyed hash and recovers the 6-digit code with the run's own throw-away MAC key; the real
binary has no injectable clock, so scenario 3 seeds the approver's `cred_at` 8 days back in the
identity database.

Not wired (recorded as not run, never faked): sync gateway behind the real identity service (it still
uses `identitystub`), sync push/pull load (no standalone signed-op client), NATS bus relay.

```
go vet -tags e2e ./...
scripts/build.sh /tmp/e2e/bin /tmp/e2e/src
E2E_BIN=/tmp/e2e/bin E2E_INFRA=../infra/dev go test -tags e2e -count=1 -v ./e2e
```
