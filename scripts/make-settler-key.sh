#!/usr/bin/env bash
# Make the live settler's testnet account and key (see sim/src/settler.ts and docs/TESTNET.md).
#
# Uses the owner credentials the other chain targets use: NEAR_ACCOUNT and NEAR_PRIVATE_KEY in darwin/.env (or the
# environment). Creates settler-v2.<NEAR_ACCOUNT> with ONE function-call access key: receiver market2.<NEAR_ACCOUNT>,
# method transfer_internal, 0.75 NEAR gas allowance. No full-access key exists on that account.
# The key is written only to the gitignored .env as DARWIN_SETTLER_ACCOUNT / DARWIN_SETTLER_KEY and never printed.
# To use it on a host, copy those two values into the host's environment.
set -euo pipefail
cd "$(dirname "$0")/../sim"
git -C .. check-ignore -q .env || { echo ".env is not gitignored; refusing to write a key there" >&2; exit 1; }
exec node --import tsx src/chain2.ts settler
