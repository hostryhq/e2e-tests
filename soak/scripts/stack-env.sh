#!/usr/bin/env bash
# Source me: environment of the Phase 2 local stack started by infra/dev/up-full.sh, for the soak tools.
# Defaults match the ports the soak run uses (HOSTRY_*_PORT of up-full.sh, state in HOSTRY_LOCAL_DIR).
# The identity block mirrors env_identity() of up-full.sh so `identity vendor bootstrap` reaches the same database.
state="${HOSTRY_LOCAL_DIR:-/tmp/hostry-soak/local}"
keys="$state/keys"
pgport="${HOSTRY_PG_PORT:-15432}"
natsport="${HOSTRY_NATS_PORT:-14222}"
export SOAK_STATE="$state"
export SOAK_PG_PORT="$pgport"
export SOAK_IDENTITY_URL="http://127.0.0.1:${HOSTRY_IDENTITY_PORT:-28101}"
export SOAK_TENANCY_URL="http://127.0.0.1:${HOSTRY_TENANCY_PORT:-28102}"
export SOAK_ADMIN_URL="http://localhost:${HOSTRY_ADMIN_PORT:-28103}"
export SOAK_ADMIN_ORIGIN="$SOAK_ADMIN_URL"
export SOAK_BILLING_URL="http://127.0.0.1:${HOSTRY_BILLING_PORT:-28107}"
export SOAK_ORDERS_URL="http://127.0.0.1:${HOSTRY_ORDERS_PORT:-28106}"
export SOAK_CATALOG_URL="http://127.0.0.1:${HOSTRY_CATALOG_PORT:-28105}"
export SOAK_NATS_URL="nats://127.0.0.1:$natsport"
export SOAK_NATS_SEED_SYNC="$state/nats/seeds/sync.nk"
export SOAK_IDENTITY_BIN="$state/bin/identity"
export SOAK_PG_DSN_SYNC="postgres://hostry:hostry-dev-only@127.0.0.1:$pgport/sync?sslmode=disable"

export HOSTRY_ENV=dev
export HOSTRY_IDENTITY_DSN="postgres://hostry:hostry-dev-only@127.0.0.1:$pgport/identity?sslmode=disable"
export HOSTRY_IDENTITY_DB_ROLE=identity_app
export HOSTRY_IDENTITY_LISTEN="127.0.0.1:${HOSTRY_IDENTITY_PORT:-28101}"
export HOSTRY_IDENTITY_TENANT_KEY_FILE="$keys/tenant.key"
export HOSTRY_IDENTITY_VENDOR_KEY_FILE="$keys/vendor.key"
export HOSTRY_IDENTITY_PACK_KEY_FILE="$keys/pack.key"
export HOSTRY_IDENTITY_MAC_KEY_FILE="$keys/mac.b64"
export HOSTRY_IDENTITY_PROOF_KEY_FILE="$keys/proof.b64"
export HOSTRY_IDENTITY_TOTP_KEY_FILE="$keys/totp.b64"
export HOSTRY_SERVICE_KEYS_DIR="$keys/service-pub"
export HOSTRY_TENANCY_URL="$SOAK_TENANCY_URL"
export HOSTRY_SERVICE_SIGNING_KEY_FILE="$keys/identity.key"
export HOSTRY_OP_SIGNING_PUB_FILE="$keys/sync-op.pub.pem"
export HOSTRY_IDENTITY_SMS=test
export HOSTRY_IDENTITY_ALLOW_TEST_SMS=1
export HOSTRY_IDENTITY_DEV_CAPTURE=1
export HOSTRY_NATS_URL="$SOAK_NATS_URL"
export HOSTRY_NATS_SEED_FILE="$state/nats/seeds/identity.nk"
