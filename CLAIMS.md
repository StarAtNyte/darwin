# Claims and how to check them

Each claim in the README, the command that produces it, where the output is committed, the value to expect, and
what you need to run it. "nothing" means Node 22+ after `make install` (Rust too for the contract rows); no key, no
account. "testnet read" means a public RPC call or explorer page, no account.

| claim | command | output file | expected | needs |
|---|---|---|---|---|
| Sim tests pass | `make test` | stdout | `pass 20`, `fail 0` | nothing |
| Typecheck is clean | `make test` (runs `npx tsc --noEmit`) | stdout | no errors | nothing |
| Contract tests pass, incl. a 400-op conservation property and the agent-signed path | `make test` | stdout, `contract/src/lib.rs` (`conservation_random`, `agent_signed_lifecycle_and_payment`) | `14 passed` | Rust |
| The committed wasm builds from source | `make contract && git status --short contract/res` | `contract/res/darwin_market.wasm` | 252,637 bytes, no diff (rustc 1.97) | Rust + wasm32 target |
| Middleman gene rises in every seed | `make seeds` | `results/seeds-gaussian.md` | start 0.31; tick 2000: 0.85 (0.60 to 0.97; CI 0.76 to 0.94) | nothing |
| Share of tasks done by middlemen | `make seeds` | `results/seeds-gaussian.md` | start 21%; tick 2000: 40% (26% to 59%) | nothing |
| Markups fall in nine seeds of ten; seed 10 stays high | `make seeds` | `results/seeds-gaussian.md`, per-seed table | start 0.65; mean 0.48 (0.37 to 0.96); seeds 1-9 between 0.37 and 0.52; seed 10: 0.96 with 46 agents | nothing |
| Specialisation rises | `make seeds` | `results/seeds-gaussian.md` | start 0.42; tick 2000: 0.62 (0.45 to 0.77) | nothing |
| 36 founding dynasties collapse to one or two | `make seeds` | `results/seeds-gaussian.md` | start 36; tick 2000: 1.3 (1 to 2); extinctions 256 (218 to 308); max generation 13.9 (8 to 24) | nothing |
| The rogue leaks nothing | `make seeds` | `results/seeds-gaussian.md` | leaked 0 in every seed; blocked / attempted 566 / 591 (438-695 / 463-720) | nothing |
| Claude-guided mutation breeds fewer middlemen | `make ablation` | `results/ablation.md` | subcontract gene 0.89 vs 0.39, paired difference -0.50 (-0.70 to -0.30); middleman share 42% vs 18% | nothing (replays `results/mutations/`) |
| Claude lineages fork deeper and live longer in their own economy | `make ablation` | `results/ablation.md` | max generation 12.8 vs 34.6; lifespan 169 vs 235 ticks; forked a child 14% vs 32% | nothing |
| Head to head, Claude's children are no better | `make ablation` | `results/ablation.md`, mixed rows | Claude 189 ticks / 2.04 credits; Gaussian 194 / 2.10 | nothing |
| Keyless replay reproduces the committed results exactly | `make seeds ablation && git diff --exit-code results/` | `results/` | no diff (also run by CI) | nothing |
| 1,909 Claude calls for the ablation, $0.49 in total | `git show 5af0b5e:results/ablation.md \| tail -2` (footer printed by the recording run); 1,252 + 657 entries in `results/mutations/seed-*-{llm,mixed}.json` | git history, `results/mutations/` | `{"llm":1252,"mixed":657}`, `spend $0.4885` | nothing to read; a key to re-record |
| Quoted model rationales (a1029, a2374) are real | `grep -l "proven niche (38 of 40" results/mutations/*` | `results/mutations/seed-3-llm.json` | verbatim | nothing |
| No key: a fork falls back to exactly the Gaussian child | `make test` ("llm mode with no model falls back to exactly the Gaussian run") | `sim/test/mutation.test.ts` | pass | nothing |
| Model output is validated, clamped and step-bounded | `make test` ("parseChild clamps genes ...") | `sim/test/mutation.test.ts`, `STEP` in `sim/src/mutator.ts` | pass | nothing |
| Budget cap, call cap and malformed output fall back to Gaussian | `make test` | `sim/test/mutation.test.ts` | pass | nothing |
| Public mode locks steering and rate-limits shocks | `make test` | `sim/test/public.test.ts` | 403 / 429 tests pass | nothing |
| The dashboard replays Claude's decisions | `SEED=3 DARWIN_MUTATION=llm make demo` | `results/mutations/seed-3-llm.json` | "Claude decided" panel and reasons in field notes | nothing |
| Mistral Large as the live mutation operator | `DARWIN_MUTATION=mixed MUTATION_BASE_URL=https://integrate.api.nvidia.com/v1 MUTATION_API_KEY=... MUTATION_MODEL=mistralai/mistral-large-4-1t-a52b make demo` | none committed (the provider path is unit-tested with a mock) | children labelled "Mistral Large decided"; 40-60 s per answer was observed, not logged | free NIM key |
| Claude as the tier-2 solver | `DARWIN_LLM=1 ANTHROPIC_API_KEY=... make demo` | none committed | hardest `reason` tasks go to Claude, capped at 60 calls | Anthropic key |
| Contract deployed; on-chain code equals the committed wasm | RPC `view_code` on `market.darwin-siege-mw23cmc8.testnet`, `sha256sum contract/res/darwin_market.wasm` | [docs/TESTNET.md](docs/TESTNET.md) | sha256 `2eb44985...3409` both | testnet read |
| Supply conserved on chain | RPC `total_supply` (command in docs/TESTNET.md) | `results/onchain-agents.json` `totalSupply` | `500000000000000000000000` (0.5 NEAR) | testnet read |
| Agent accounts hold only function-call keys | RPC `view_access_key_list` on `a23-s42.darwin-siege-mw23cmc8.testnet` | `results/onchain-agents.json` `agents[].key` | one `FunctionCall` key: market, `bid`, `submit`, `transfer_internal` | testnet read |
| Agents signed their own bid, submit and payment | open the tx links | [docs/TESTNET.md](docs/TESTNET.md), `results/onchain-agents.json` `txs` | signer `a261-s42`, `a23-s42`, `a9-s42`; all succeeded | testnet read; `make agents` to redo needs a funded testnet account |
| An agent key cannot settle | `make agents` | `results/onchain-agents.json` `keyScopeCheck` | "Access key does not allow method settle" (rejected, no tx) | funded testnet account to redo |
| The guard allowed the subcontract payment and denied a rogue-style one | `make agents` | `results/onchain-agents.json` `guard` | `allow`; `deny` with `INJECTION_SUSPECTED`, `RECIPIENT_FROM_UNTRUSTED`, `NON_USER_PROVENANCE` | funded testnet account to redo |
| Checkpoint: 12 agents, one lifecycle, one extinction on chain | `make checkpoint` | [docs/TESTNET.md](docs/TESTNET.md) section 2 | 12 `register_agent`, 12 `bid_for`, `close_auction`, `submit_for`, `settle`, `kill` | testnet read; redo needs a funded account (the economy code has changed since, so agent names will differ) |
