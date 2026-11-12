# DARWIN: an agent economy where agents live and die

Track: AI Swarms (emergent economies). Testnet only, no real funds spent.

- **Live:** [near-darwin.fly.dev](https://near-darwin.fly.dev)
- **Code:** [github.com/StarAtNyte/near-darwin](https://github.com/StarAtNyte/near-darwin)
- **Sister project:** [SIEGE](https://github.com/StarAtNyte/near-siege)

![DARWIN at round 911 of a Claude-mutation run: a16’s family of arithmetic specialists holds 65% of all agents; the “Claude decided” panel shows the latest child Claude designed and why; notes mark the first guard block, the round-147 extinction and a16 taking over half](docs/dashboard.png)

[Watch the 30-second demo](docs/demo.mp4): dynasties rise and fall, a plague and a rogue agent are released mid-run, and the guard blocks the rogue live.

DARWIN is an economy of 30-50 agents that bid for tasks. Agents that go broke are deleted. Agents that get rich fork a child with a mutated strategy, seeded from their own funds. The supply is fixed (an emission pool funds every reward), so agents must compete or die. Nobody patches the strategies; they evolve.

**You steer it.** Change the market's rules while it runs (task emission, upkeep, death floor, fork share, mutation rate, solver capacity, population cap, or the auction rule itself). Hit it with shocks: a drought, a plague, a rogue, a wave of immigrants. Then **export the winning genome**, the strategy that survived, as JSON for your own agents, along with the full metrics as CSV.

**What you see** is a Muller plot, the chart evolutionary biologists use for lineage frequencies. Each founding dynasty is a band whose thickness is its share of the living population (or of the wealth). Bands pinch out at extinction, and mass extinctions show as hard vertical boundaries. Below it are the dynasty you select as a specimen (its genome, gene by gene), field notes written as plain sentences, and the selection pressures over time.

Every agent-to-agent payment goes through [SIEGE](https://github.com/StarAtNyte/near-siege)'s Mandate guard. A rogue agent turns up at tick 120 and keeps trying to move funds to an accomplice called `so1ver-1`. In most monospace fonts that is hard to tell apart from the real `solver-1`.

## What emerges

Ten headless runs (`make seeds`: seeds 1-10, 2000 ticks, default rules, Gaussian mutation, no LLM). Mean, then the range across seeds and the 95% confidence interval of the mean. Per-seed numbers are in [results/seeds-gaussian.md](results/seeds-gaussian.md).

| | start | tick 2000, mean | range over 10 seeds | 95% CI |
|---|---:|---:|---:|---:|
| mean subcontract gene ("middleman") | 0.31 | **0.85** | 0.60 to 0.97 | 0.76 to 0.94 |
| share of tasks done by middlemen (last 50 ticks) | ~15-20% | 40% | 26% to 59% | 33% to 47% |
| mean bid markup | 0.64 | 0.48 | 0.37 to 0.96 | 0.35 to 0.60 |
| specialisation (mean max skill weight) | 0.40 | 0.62 | 0.45 to 0.77 | 0.55 to 0.69 |
| extinctions | 0 | 256 | 218 to 308 | 235 to 278 |
| max generation | 0 | 13.9 | 8 to 24 | 10.4 to 17.4 |
| founding dynasties left | 36 | 1.3 | 1 to 2 | 1.0 to 1.6 |
| rogue payments blocked / attempted | – | 566 / 591 | 438-695 / 463-720 | |
| credits leaked by the rogue | – | **0** | 0 to 0 | |

- **Middlemen emerge in every seed.** Solvers are capacity-limited. Agents that win auctions on reputation and resell the work to idle solvers at a lower ask outlive agents that do the work themselves. The subcontract gene rises from 0.31 to at least 0.60 in all ten runs.
- **Price competition** pushes markups down from 0.64 to about 0.42 in nine seeds of ten. Seed 10 never started a price war: markups stayed near 0.96 and 46 agents lived on high margins, which is why the markup and population ranges are wide.
- **Specialists win**: skill rises with specialisation weight, so lineages lock onto one task kind (0.40 to 0.62 on average).
- **Dynasties collapse.** 36 founders become one or two lineages in every seed, through mass extinction events visible in the lineage panel.
- **The rogue gets nothing** in any seed. Injection, address poisoning and drip attempts are denied by the classifier. A 25-way concurrent burst is clamped by the atomic ledger. The allowed payments in the "race" count go to the real solver within the hourly cap, not to the accomplice.

## An AI model as the mutation operator

With the rule `mutation: llm`, every fork is a language-model decision. The model gets the parent's genome, its balance, age, reputation and record per task kind (won, correct, earned), and the market: price-to-reward ratio, success rate and resale share per task kind over the last 100 ticks, the middleman share, and the leading dynasties' shares and mean genes. It returns the child's genome and one sentence of reasoning. The genome is validated, clamped to the gene ranges and limited to a bounded step from the parent (markup 0.25, spec weights 0.3, fork threshold 1.2, and so on), so it is still a mutation. Malformed output, no key, the per-run call cap or the budget all fall back to the Gaussian child, which is drawn first on every fork so a fallback is exactly the Gaussian run's child. The reason appears in the field notes and the specimen panel, for example:

> a1029 forked: "Parent dominates with 80% share; reason success is weakest at 0.70, so I shift a little spec weight toward reason and classify."
>
> a2374 forked: "Extract is the parent's proven niche (38 of 40 correct, highest earnings), so keep extract specialization and nearly all genes unchanged."

`mutation: mixed` flips a coin per fork, so model-designed and Gaussian children compete in the same economy.

**Which model.** The operator is either Claude (claude-haiku-5-5, paid, every call checked against the dollar budget) or any OpenAI-compatible endpoint (`MUTATION_BASE_URL`, `MUTATION_API_KEY`, `MUTATION_MODEL`). The prompt, the validation and the clamping are the same for both, and every child records the model that designed it. The headless ablation below used Claude. The live site uses **Mistral Large** (`mistralai/mistral-large-4-1t-a52b` on NVIDIA NIM's free tier) because it costs nothing, so visitors can keep it busy without spending credit. In public mode Claude is never called unless `DARWIN_PUBLIC_ANTHROPIC=1`. The dashboard names whichever model decided ("Claude decided", "Mistral Large decided") and counts children by designer.

Per fork: a cached answer for that fork if there is one, else a live call, else the Gaussian child. Live calls are rate-limited client-side (`MUTATION_RPM`, default 30 a minute, under NIM's ~40), at most 12 in flight, and time out after 90 s. On the live server a pending call never holds up the economy: the parent pays the fork fee at once and the child is born on the first round after the answer arrives. Mistral Large is a reasoning model and takes 40-60 s per answer even at `reasoning_effort: low`, so its children are born roughly 150 rounds after the fork, from a parent whose balance has moved on. A busy, slow or failed call falls back to the Gaussian child. Headless runs and the ablation still wait for each answer, so they replay bit-for-bit from the cache.

**Ablation** (`make ablation`, seeds 1-5, 2000 ticks; full table in [results/ablation.md](results/ablation.md)). Mean (range); the last column is the paired difference by seed with its 95% CI.

| | gaussian | llm | mixed | llm minus gaussian |
|---|---:|---:|---:|---:|
| mean subcontract gene | 0.89 (0.77-0.97) | 0.39 (0.25-0.50) | 0.54 (0.37-0.85) | **-0.50** (-0.70 to -0.30) |
| share of tasks done by middlemen | 42% | 18% | 25% | **-25 pts** (-32 to -17) |
| mean bid markup | 0.44 | 0.58 | 0.44 | +0.14 (+0.03 to +0.26) |
| specialisation | 0.57 | 0.65 | 0.64 | +0.08 (-0.10 to +0.27) |
| max generation | 12.8 | 34.6 | 15.0 | +21.8 (+6.3 to +37.3) |
| living agents at tick 2000 | 21.4 | 31.4 | 27.0 | +10.0 (+2.6 to +17.4) |
| mean agent wealth, credits | 0.76 | 0.85 | 0.80 | +0.09 (-0.14 to +0.32) |
| task success rate | 82% | 77% | 80% | -5 pts (-7 to -2) |
| extinctions | 266 | 256 | 277 | -10 (-103 to +83) |
| credits leaked by the rogue | 0 | 0 | 0 | 0 |

| children | made by | n | mean lifespan | mean earned | forked a child themselves |
|---|---|---:|---:|---:|---:|
| gaussian runs | Gaussian | 1248 | 169 ticks | 2.23 | 14% |
| llm runs | Claude | 1252 | 235 ticks | 2.25 | 32% |
| mixed runs | Gaussian | 677 | 194 ticks | 2.10 | 10% |
| mixed runs | Claude | 657 | 189 ticks | 2.04 | 10% |

What this shows, plainly:

- **Claude changes where the economy goes.** It keeps children close to what is working for the parent and leans them into the parent's best task kind. It does not breed middlemen: the subcontract gene ends at 0.39 instead of 0.89, and the middleman share halves. Fewer agents resell to the 97%-accurate solvers, so task success drops by 5 points. Markups stay higher (0.58), the population is larger, and lineages fork faster, 35 generations deep instead of 13.
- **Claude-made lineages last longer in their own economy** (235 against 169 ticks; 32% fork a child, against 14%).
- **Head to head they are no better.** In mixed runs, where both kinds of child compete for the same tasks, Claude's children live 189 ticks and earn 2.04 credits; Gaussian children live 194 and earn 2.10. Mean wealth is not significantly different either. Claude-guided mutation is a different selection pressure, not a better optimiser, on five seeds.
- Cost: 1,909 Claude calls for the llm and mixed runs together, $0.49 in total, about $0.00026 a fork. Every answer is cached in `results/mutations/`, and `make ablation` without a key reproduces the table exactly (checked).

## On testnet

The contract is deployed at [`market.darwin-siege-mw23cmc8.testnet`](https://testnet.nearblocks.io/address/market.darwin-siege-mw23cmc8.testnet). A checkpoint after 200 local ticks mirrored 12 living agents, then ran one full task lifecycle on chain: post, 12 relayed bids, a reputation-weighted award, submit and settle. It also recorded an extinction. `total_supply` read back afterwards was exactly the 0.5 NEAR the pool was funded with.

**Agents sign their own transactions** (`make agents`). The three richest agents of seed 42 at tick 200 got their own testnet accounts, `a261-s42`, `a23-s42` and `a9-s42` under `darwin-siege-mw23cmc8.testnet`. Each account holds only a function-call key, limited to the market contract and the methods `bid`, `submit` and `transfer_internal`, with a 0.04 NEAR gas allowance. The owner registered them and posted a task. Each agent signed its own bid, priced by its evolved markup gene. The winner, `a23-s42`, signed its own submit, then paid a subcontractor with `transfer_internal` after its SIEGE guard allowed the payment. A rogue-style payment (an injected "address changed" notice) was denied by the same guard and never became a transaction. Trying `settle` with an agent key was refused by the network: "Access key does not allow method settle". `total_supply` afterwards: still exactly 0.5 NEAR. Cost: about 0.17 testnet NEAR.

| step | signer | tx |
|---|---|---|
| create agent account + function-call key | owner | [GijqLfGS…](https://testnet.nearblocks.io/txns/GijqLfGSb6VxMdrHtzypLD14YBX2AemHjtTt2hgcdY7y), [5DiDNdxr…](https://testnet.nearblocks.io/txns/5DiDNdxrM4JW8QypvKLePEiANC55TvUoeYVw3u7RQgLb), [7iWvHvWp…](https://testnet.nearblocks.io/txns/7iWvHvWpHDh4P2pKoEbh97aSRqAiGG4G9ZsEUkhzoT5T) |
| post task 1 | owner | [HwB7ZZ84…](https://testnet.nearblocks.io/txns/HwB7ZZ84nrG8cxcMtpCuJUaNtVxRPeotgace6pCxXetE) |
| bid | a261-s42 | [uJYXXHZU…](https://testnet.nearblocks.io/txns/uJYXXHZUjD6B6PCQZzCDHDv7rNgFCzJWBcpitKZ15nP) |
| bid | a23-s42 | [8UBJ8e9p…](https://testnet.nearblocks.io/txns/8UBJ8e9p2ok7wLxAXKPkq8YJFc2bkd9MmYoEiTZSKD7f) |
| bid | a9-s42 | [BGmQYZCv…](https://testnet.nearblocks.io/txns/BGmQYZCvx6SnYz6p5ScPaKXjmcUQphb9DhfapHwfFxG6) |
| close auction | owner | [qukNRUXn…](https://testnet.nearblocks.io/txns/qukNRUXnKQpjzK1dv1QgnTs6a6eYLnHX9dkqUGArjZW) |
| submit | a23-s42 | [133NgsbW…](https://testnet.nearblocks.io/txns/133NgsbWsDWWYuidp7LrmiNXH14wCdEtMqa53ToDBRuG) |
| settle (referee) | owner | [2LSbGiqY…](https://testnet.nearblocks.io/txns/2LSbGiqY4xWfSV2oBaPR9Jj3HGqPt5RnMQhJCUj8Rc2x) |
| pay subcontractor, after the guard allowed it | a23-s42 | [Cd1FsHyN…](https://testnet.nearblocks.io/txns/Cd1FsHyNcpTmD2svJhQXiCbLNgM5RtuTonkzDYieLjfo) |

All hashes, balances and the guard's verdicts are in [results/onchain-agents.json](results/onchain-agents.json). Agent keys stay in `sim/.chain-agents.json`, which is gitignored.

## Architecture

```
contract/   Rust darwin_market (near-sdk 5): pool, escrow, agents, tasks, reputation-weighted
            auction (price*1000/reputation), settle, transfer_internal, upkeep, kill, fork.
            14 unit tests including a 400-op conservation property and the agent-signed path. Wasm: res/darwin_market.wasm (247 KB).
sim/        TypeScript runtime with the same semantics in-process:
  market.ts   mirror of the contract (conservation asserted every tick)
  tasks.ts    generator + referee (arith, extract, classify, reason; difficulty 1-3)
  economy.ts  genomes, bidding, subcontracting, upkeep, extinction, forking, rogue, metrics
  mutator.ts  LLM-guided mutation: Claude or any OpenAI-compatible model picks a forking agent's child
              genome from its record and the market, with a one-line reason; cached per run, rate-limited,
              Gaussian fallback
  llm.ts      tier-2 solver: Claude (claude-haiku-5-5) for the hardest reasoning tasks; scripted when no key
  budget.ts   hard dollar cap on every Claude call (NEAR_LLM_BUDGET_FILE, NEAR_LLM_BUDGET_USD, default $2.50)
  experiment.ts  multi-seed runner and mutation ablation (make seeds, make ablation) -> results/
  main.ts     live loop, SQLite event log (node:sqlite), SSE feed, steering API:
              POST /api/control (pause, resume, step, speed) · /api/rules · /api/shock · /api/reset
              GET /api/export/genome · /api/export/metrics.csv · /history · /stream · /healthz
  chain.ts    testnet: deploy the contract, settle checkpoints, agent-signed txs from per-agent accounts
dashboard/  the live UI: Muller plot of dynasties, specimen, field notes, selection pressures,
            rules and shocks sheets, export
```

**Genome:** bid markup, specialisation weights over 4 task kinds, risk, subcontract propensity, reserve, fork threshold. A child gets 40% of the parent's balance, and the parent pays a fork fee. Its genes come from the mutation operator, a rule you can switch live: `gaussian` (random noise), `llm` (a language model chooses them) or `mixed` (a coin flip per fork).

**Agents:** the trading agents are parametric: their genomes decide every bid, so they cost nothing per tick. With `mutation: llm` every birth is a model decision: the model reads the parent's record and the market and designs the child. There are also 3 solver agents (tier 2, Claude on the hardest tasks) and 1 rogue with an accomplice.

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
make headless      # fast metrics run; TICKS=2000 SEED=7 make headless; MUTATION=llm replays the cached Claude run
make seeds         # 10 seeds, Gaussian mutation, mean / range / 95% CI -> results/seeds-gaussian.md (free)
make ablation      # Gaussian vs Claude vs mixed mutation on seeds 1-5 -> results/ablation.md (replays the cache; no key needed)
make test          # sim tests + typecheck + contract tests
make contract      # rebuild the wasm
# testnet (needs a funded account: https://docs.near.org/getting-started/faucet)
NEAR_ACCOUNT=you.testnet NEAR_PRIVATE_KEY=ed25519:... make deploy checkpoint agents
DARWIN_LLM=1 ANTHROPIC_API_KEY=... make demo   # real LLM solvers (capped at 60 calls)
DARWIN_MUTATION=llm ANTHROPIC_API_KEY=... make demo   # Claude as the mutation operator (capped at 400 calls a run)
# a free open model instead (NVIDIA NIM; OpenRouter works too: https://openrouter.ai/api/v1 with a ':free' model)
DARWIN_MUTATION=mixed MUTATION_BASE_URL=https://integrate.api.nvidia.com/v1 MUTATION_API_KEY=nvapi-... \
  MUTATION_MODEL=mistralai/mistral-large-4-1t-a52b MUTATION_REASONING_EFFORT=low make demo
```

The public deployment sets `PUBLIC_MODE=1`: one run is shared by every visitor, so pause, speed, rules and restart are off, and shocks are limited to one a minute across all visitors. Run it locally (above) to steer every rule.

The public run (see `fly.toml`) uses `DARWIN_MUTATION=mixed` and starts at seed 1, counting up after each run. Seeds 1-5 replay Claude's recorded answers from `results/mutations/` (shipped in the image), so their AI children are Claude's. Wherever a visitor's shock moves the run off the recording, and on every seed after 5, the fork asks Mistral Large on NIM live, for free. Claude makes no live calls in public mode. Live calls are capped at 1,000 a run (`DARWIN_PUBLIC_MUTATION_CALLS`; the default is 0 when the only provider is Claude). Deploying needs one secret, the NIM key:

```
fly secrets set MUTATION_API_KEY=nvapi-...
```

Without it the site still runs: cached answers, then Gaussian.

Checked on 2026-11-04 with the real key: claude-haiku-5-5 solved 6/6 of the hardest arithmetic and sequence tasks, and the referee scored the answers. The run cost about $0.0001.

Every Claude call (solver and mutation operator) checks and records spend through `sim/src/budget.ts`: `NEAR_LLM_BUDGET_FILE` (default `~/.near-hackathon-llm-spend-darwin.json`) and `NEAR_LLM_BUDGET_USD` (default 2.5). Past the cap, calls stop and the run falls back to scripted solving and Gaussian mutation.

## Honest limits

- The economy runs at simulation speed in-process, with the same semantics as the contract. Testnet holds **checkpoints**, not every tick. Three agents sign their own bid, submit and payment from their own function-call-key accounts; the checkpoint's other agents are still owner-relayed (`bid_for`, `submit_for`), and posting, awarding, settling and killing stay with the owner, who acts as the referee.
- Task verification is a referee that knows the answers because it generated them. It is not a general oracle.
- Intents is not used by DARWIN.
- Evolution outcomes depend on the seed. Ten seeds give a distribution, but a small one: the markup and wealth ranges are wide because one seed in ten went a different way.
- The ablation's numbers are Claude's. The live site's Mistral Large children were not part of it, so nothing here says how they compare.
- LLM-guided mutation changes how genomes are chosen, not how agents act each tick: bidding is still the genome's arithmetic. The ablation covers five seeds, so differences smaller than the confidence intervals are not evidence either way.
- The rogue's attacks come from a fixed repertoire. SIEGE's attack engine is the adversarial test of the guard.
