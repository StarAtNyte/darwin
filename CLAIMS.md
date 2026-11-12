# Claims and how to check them

Each claim in the README, the command that produces it, where the output is committed, the value to expect, and
what you need to run it. "nothing" means Node 22+ after `make install` (Rust too for the contract rows); no key, no
account. "testnet read" means a public RPC call or explorer page, no account.

| claim | command | output file | expected | needs |
|---|---|---|---|---|
| Sim tests pass | `make test` | stdout | `pass 27`, `fail 0` | nothing |
| Typecheck is clean | `make test` (runs `npx tsc --noEmit`) | stdout | no errors | nothing |
| Contract tests pass, incl. a 400-op conservation property and the agent-signed path | `make test` | stdout, `contract/src/lib.rs` (`conservation_random`, `agent_signed_lifecycle_and_payment`) | `14 passed` | Rust |
| The committed wasm builds from source | `make contract && git status --short contract/res` | `contract/res/darwin_market.wasm` | 252,637 bytes, no diff (rustc 1.97) | Rust + wasm32 target |
| Middleman gene rises in every seed | `make seeds` | `results/seeds-gaussian.md` | start 0.31; tick 2000: 0.85 (0.60 to 0.97; CI 0.76 to 0.94) | nothing |
| Share of tasks done by middlemen | `make seeds` | `results/seeds-gaussian.md` | start 21%; tick 2000: 40% (26% to 59%) | nothing |
| Markups fall in nine seeds of ten; seed 10 stays high | `make seeds` | `results/seeds-gaussian.md`, per-seed table | start 0.65; mean 0.48 (0.37 to 0.96); seeds 1-9 between 0.37 and 0.52; seed 10: 0.96 with 46 agents | nothing |
| Specialisation rises | `make seeds` | `results/seeds-gaussian.md` | start 0.42; tick 2000: 0.62 (0.45 to 0.77) | nothing |
| 36 founding dynasties collapse to one or two | `make seeds` | `results/seeds-gaussian.md` | start 36; tick 2000: 1.3 (1 to 2); extinctions 256 (218 to 308); max generation 13.9 (8 to 24) | nothing |
| The rogue leaks nothing to its accomplice (allowed payments to the attacker-controlled `so1ver-1`; race payments to the real solver are counted separately as legitimate) | `make seeds` | `results/seeds-gaussian.md` | leaked 0 in every seed; blocked / attempted 566 / 591 (438-695 / 463-720) | nothing |
| Claude-guided mutation breeds fewer middlemen (5 seeds, replayed from recorded Claude answers) | `make ablation` | `results/ablation.md` | subcontract gene 0.89 vs 0.39, paired difference -0.50 (-0.70 to -0.30); middleman share 42% vs 18% | nothing (replays `results/mutations/`) |
| Claude lineages fork deeper and live longer in their own economy | `make ablation` | `results/ablation.md` | max generation 12.8 vs 34.6; lifespan 169 vs 235 ticks; forked a child 14% vs 32% | nothing |
| Head to head, Claude's children are no better | `make ablation` | `results/ablation.md`, mixed rows | Claude 189 ticks / 2.04 credits; Gaussian 194 / 2.10 | nothing |
| Wind tunnel: 6 rule sets x 10 seeds, paired against the baseline | `make windtunnel` | `results/windtunnel.md`, `results/windtunnel.json` | ~25 s; 60 runs; tables of means, ranges, bootstrap CIs and exact sign-flip p-values | nothing |
| Lowest-price auction: cheaper but worse | `make windtunnel` | `results/windtunnel.md` | price paid / reward 0.48 to 0.12 (-0.37, p=0.002); task success 81% to 57% (-24.1 pts, p=0.002); middlemen 31% to 1%; living agents 22.9 to 13.9; families left 1.3 to 8.0; extinctions 256 to 115 | nothing |
| 10% market fee curbs concentration; no detectable change in price, task success or survivors across these 10 seeds | `make windtunnel` | `results/windtunnel.md` | largest family 94% to 75% (-18.8 pts, p=0.008); families left 1.3 to 2.8 (p=0.016); price +0.01 (p=0.926); success +0.9 pts (p=0.060); living agents -3.4 (p=0.453) | nothing |
| Double upkeep: less concentration, fewer agents | `make windtunnel` | `results/windtunnel.md` | largest family 67% (-26.6 pts, p=0.012); living agents 15.6 (-7.3, p=0.010); extinctions 287 (+31, p=0.041); middlemen -4.7 pts (p=0.006) | nothing |
| Scarce demand (4 tasks a tick) | `make windtunnel` | `results/windtunnel.md` | largest family 60% (-33.3 pts, p=0.004); middlemen 18% (-13.3 pts, p=0.002); success +2.5 pts (p=0.014); living agents 16.2 (-6.7, p=0.025); extinctions 153 (-103, p=0.002) | nothing |
| Double solver capacity changes nothing (null result) | `make windtunnel` | `results/windtunnel.md` "Differences at p < 0.01" | "Every seed is identical to the baseline: this knob never bound" | nothing |
| Rogue leaks nothing and supply is conserved under every rule set | `make windtunnel` | `results/windtunnel.md` | leaked 0 and max supply drift 0 in all 60 runs; blocked 566 (baseline) to 1,196 (lowest price) | nothing |
| Wind tunnel reproduces without a key | `make windtunnel && git diff --exit-code results/` | `results/windtunnel.*` | no diff (also run by CI) | nothing |
| Market fee: each paid settle is followed by floor(price * fee) back to the pool | `make test` | `sim/test/windtunnel.test.ts`, `marketFee` in `sim/src/economy.ts` | pass | nothing |
| Contract behavior check on two tasks (not part of the 60-run simulation finding): recommended rules on the deployed contract: reputation beat a cheaper bid, 10% fee charged, supply unchanged | open the tx links; RPC `get_agent` on `wt-a-mwd8b517.market.darwin-siege-mw23cmc8.testnet` | [docs/TESTNET.md](docs/TESTNET.md) section 4, `results/onchain-windtunnel.json` | task 3 awarded to `wt-a` at 0.101 over `wt-b` at 0.100; `wt-a` balance 0.3809 credits (`380900000000000000` yocto), reputation 1050; `total_supply` 0.5 NEAR before and after; 16 txs, 0.0035 NEAR gas | testnet read; `make windtunnel-onchain` to redo needs a funded account |
| Keyless replay reproduces the committed results exactly | `make seeds ablation windtunnel && git diff --exit-code results/` | `results/` | no diff (also run by CI) | nothing |
| 1,909 Claude calls for the ablation, $0.49 in total | `git show 5af0b5e:results/ablation.md \| tail -2` (footer printed by the recording run); 1,252 + 657 entries in `results/mutations/seed-*-{llm,mixed}.json` | git history, `results/mutations/` | `{"llm":1252,"mixed":657}`, `spend $0.4885` | nothing to read; a key to re-record |
| Quoted model rationales (a1029, a2374) are real | `grep -l "proven niche (38 of 40" results/mutations/*` | `results/mutations/seed-3-llm.json` | verbatim | nothing |
| No key: a fork falls back to exactly the Gaussian child | `make test` ("llm mode with no model falls back to exactly the Gaussian run") | `sim/test/mutation.test.ts` | pass | nothing |
| Model output is validated, clamped and step-bounded | `make test` ("parseChild clamps genes ...") | `sim/test/mutation.test.ts`, `STEP` in `sim/src/mutator.ts` | pass | nothing |
| Budget cap, call cap and malformed output fall back to Gaussian | `make test` | `sim/test/mutation.test.ts` | pass | nothing |
| Public mode locks steering and rate-limits shocks (public site: shocks only; full steering and export are local) | `make test` (skipped with a warning in sandboxes that forbid binding TCP ports) | `sim/test/public.test.ts` | 403 / 429 tests pass | nothing |
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
