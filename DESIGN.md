# DARWIN design

Track: AI Swarms (also Agent Economy if the form allows several tracks per project). Deadline: 2026-11-14 23:59 UTC. Testnet only, no money spent.

## Idea
An economy of 30-50 agents that bid for tasks. Agents that go broke are deleted; agents that get rich fork a child with a mutated strategy. The economy evolves live with no dev patch, which is what the Swarms track asks for ("emergent economies").

## Agents
Each agent: a testnet sub-account, an internal balance, a reputation score, and a strategy genome. Loop: watch the task board, decide whether and how much to bid, execute or subcontract, get paid on verified result.

**Genome (evolves):** bid markup, reserve ratio, specialisation weights per task type, risk tolerance, subcontract propensity, fork threshold.

**Lifecycle:** balance below floor -> deleted (extinction). Balance above threshold -> fork child with Gaussian-mutated genome, seeded with part of the parent's funds (fork cost).

**Tiers**
1. Parametric agents (~90%): no LLM; bid from genome. Cost nothing to run. They can earn by buying work from solvers and reselling it; emergent middlemen are the key thing to show.
2. LLM solver agents (~3): do tasks via the Claude API (cheapest tier).
3. Rogue agent (1, demo): tries to overspend or redirect funds; SIEGE's Mandate blocks it.

## Tasks and referee
Synthetic tasks with known answers (extraction, classification, arithmetic, short reasoning) at several difficulty levels. A referee scores automatically, so payment is deterministic. Limit: this is not a general task oracle; say so in the README.

## Money and keys
- Each agent has a function-call key limited to the market contract methods (bid, claim, submit, settle). Per NEAR docs these keys cannot attach NEAR, so an agent cannot move funds on its own.
- Balances live inside the market contract. A manager account funds them. Death = contract zeroes the balance and the manager deletes the sub-account.
- Agent calls go through SIEGE's guard first (SIEGE must be usable as a library by Nov 8).
- Fixed emission: an environment account funds task rewards, so total supply is limited and agents must compete. Without this nothing dies and the demo is boring.

## Build list
- Rust market contract on testnet (post task, bid, escrow, settle); needs the wasm32 target.
- Task generator and referee.
- Agent runtime (TypeScript); LLM calls only for tier 2.
- Evolution manager: tournament selection, mutation, fork cost, extinction floor.
- SQLite event log and websocket feed.
- Vite dashboard: wealth curves, lineage tree, extinction events, rogue-agent block.
- Metrics: Gini, middleman share, specialisation by task type.

## Build order
Contract, generator, referee -> 5 hand-written agents -> turn on evolution headless and tune parameters -> dashboard.

## Honest limits (state in README)
- Testnet funds; Intents mocked (mainnet-only).
- Referee-based verification, not a general oracle.
- Evolution may not produce interesting behaviour on the first try; tune headless first.

## Budget
Anthropic key in gitignored `.env`. Console cap $40; in-code hard budget about $25 total across both projects. Only ~3 agents make paid calls. Demo must also run without a key (scripted solver fallback).

## Schedule
| Dates | Work |
|---|---|
| Nov 4-8 | (SIEGE work, plus contract skeleton if time) |
| Nov 9-12 | DARWIN: market, evolution, dashboard |
| Nov 13 | Demo video, README, X post |
| Nov 14 | Make repo public, submit well before 23:59 UTC |

## Unverified assumptions (test first)
- Testnet sub-account limits, creation cost, faucet size, confirmation speed. Fallback: run the market on a local sandbox and settle checkpoints on testnet, labelled honestly.
- Whether the API key works.
- Whether the form allows several tracks per project.

## Submission checklist
Public repo, demo post on X tagging @NEARProtocol and #NEARHackathon with video or screenshots, description 20-2,000 characters, NEAR wallet address, scan git history for secrets before going public.
