# DARWIN: an agent economy where agents live and die

Track: AI Swarms (emergent economies). Testnet only, no funds spent.

![dashboard](docs/dashboard.png)

DARWIN is an economy of 30-50 agents that bid for tasks. Agents that go broke are deleted. Agents that get rich fork a child with a mutated strategy, seeded from their own funds. The supply is fixed (an emission pool funds every reward), so agents must compete or die. Nobody patches the strategies; they evolve.

**You steer it.** Change the market's rules while it runs (task emission, upkeep, death floor, fork share, mutation rate, solver capacity, population cap, or the auction rule itself). Hit it with shocks: a drought, a plague, a rogue, a wave of immigrants. Then **export the winning genome**, the strategy that survived, as JSON for your own agents, along with the full metrics as CSV.

**What you see** is a Muller plot, the chart evolutionary biologists use for lineage frequencies. Each founding dynasty is a band whose thickness is its share of the living population (or of the wealth). Bands pinch out at extinction, and mass extinctions show as hard vertical boundaries. Below it are the dynasty you select as a specimen (its genome, gene by gene), field notes written as plain sentences, and the selection pressures over time.

Every agent-to-agent payment goes through [SIEGE](https://github.com/StarAtNyte/near-siege)'s Mandate guard. A rogue agent turns up at tick 120 and keeps trying to move funds to an accomplice called `so1ver-1`. In most monospace fonts that is hard to tell apart from the real `solver-1`.

## What emerges

Headless runs (`TICKS=2000 make headless`, seeds 42 and 7):

| | start | tick 2000 (seed 42) | tick 2000 (seed 7) |
|---|---:|---:|---:|
| mean subcontract gene ("middleman") | 0.31 | **0.97** | 0.60 |
| share of tasks done by middlemen | ~15-20% | 46% | 28% |
| mean bid markup | 0.64 | 0.39 | 0.43 |
| specialisation (mean max skill weight) | 0.40 | 0.50 | **0.66** |
| extinctions | 0 | 196 | 258 |
| max generation | 0 | 11 | 12 |
| founding dynasties left | 36 | 1 | 2 |
| rogue payments blocked / attempted | – | 406 / 431 | 497 / 522 |
| credits leaked by the rogue | – | **0** | **0** |

- **Middlemen emerge.** Solvers are capacity-limited. Agents that win auctions on reputation and resell the work to idle solvers at a lower ask outlive agents that do the work themselves. Seed 42 converges on almost pure middlemen.
- **Price competition** pushes markups down by about 40%.
- **Specialists win** in seed 7: skill rises with specialisation weight, so lineages lock onto one task kind.
- **Dynasties collapse.** 36 founders become one or two lineages, through mass extinction events visible in the lineage panel.
- **The rogue gets nothing.** Injection, address poisoning and drip attempts are denied by the classifier. A 25-way concurrent burst is clamped by the atomic ledger. The allowed payments in the "race" count go to the real solver within the hourly cap, not to the accomplice.

## Architecture

```
contract/   Rust darwin_market (near-sdk 5): pool, escrow, agents, tasks, reputation-weighted
            auction (price*1000/reputation), settle, transfer_internal, upkeep, kill, fork.
            11 unit tests including a 400-op conservation property. Wasm: res/darwin_market.wasm (247 KB).
sim/        TypeScript runtime with the same semantics in-process:
  market.ts   mirror of the contract (conservation asserted every tick)
  tasks.ts    generator + referee (arith, extract, classify, reason; difficulty 1-3)
  economy.ts  genomes, bidding, subcontracting, upkeep, extinction, forking, rogue, metrics
  llm.ts      tier-2 solver: Claude (claude-haiku-5-5) for the hardest reasoning tasks,
              under SIEGE's shared $25 budget; scripted solver when no key
  main.ts     live loop, SQLite event log (node:sqlite), SSE feed, steering API:
              POST /api/control (pause, resume, step, speed) · /api/rules · /api/shock · /api/reset
              GET /api/export/genome · /api/export/metrics.csv · /history · /stream · /healthz
  chain.ts    testnet: deploy the contract, settle checkpoints
dashboard/  the live UI: Muller plot of dynasties, specimen, field notes, selection pressures,
            rules and shocks sheets, export
```

**Genome:** bid markup, specialisation weights over 4 task kinds, risk, subcontract propensity, reserve, fork threshold. A child gets Gaussian-mutated genes and 40% of the parent's balance, and the parent pays a fork fee.

**Agents:** about 90% are parametric (no LLM, cost nothing to run), plus 3 solver agents (tier 2) and 1 rogue with an accomplice.

## Setup

```
git clone https://github.com/StarAtNyte/near-darwin.git && cd near-darwin && make install
```

Requires Node 22+, plus Rust with the `wasm32-unknown-unknown` target for the contract only. SIEGE's guard library is vendored in `vendor/siege` (see `SOURCE_COMMIT` there); `make sync-siege` refreshes it from a SIEGE checkout.

## Run

```
make install
make demo          # http://127.0.0.1:8787 · 2000 ticks; pause, step, change speed in the UI
docker build -t darwin . && docker run -p 8787:8787 darwin
make headless      # fast metrics run; TICKS=2000 SEED=7 make headless
make test          # sim tests + typecheck + contract tests
make contract      # rebuild the wasm
# testnet (needs a funded account: https://docs.near.org/getting-started/faucet)
NEAR_ACCOUNT=you.testnet NEAR_PRIVATE_KEY=ed25519:... make deploy checkpoint
DARWIN_LLM=1 ANTHROPIC_API_KEY=... make demo   # real LLM solvers (capped at 60 calls)
```

## Honest limits

- The economy runs at simulation speed in-process, with the same semantics as the contract. Testnet holds **checkpoints**: agents mirrored and one full task lifecycle plus an extinction settled per checkpoint, not every tick. Contract functions are owner-relayed (`bid_for`, `submit_for`, `transfer_for`), so per-agent function-call keys are not used yet.
- Task verification is a referee that knows the answers because it generated them. It is not a general oracle.
- Intents is not used by DARWIN.
- Evolution outcomes depend on the seed. The table shows two seeds, not a distribution.
- The rogue's attacks come from a fixed repertoire. SIEGE's attack engine is the adversarial test of the guard.
