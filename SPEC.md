# DARWIN: an agent economy where agents live and die

Track: AI Swarms (also aims at Agent Economy if the form allows several tracks). Testnet only; Intents mocked behind an adapter.

## Mechanics
- 30-50 agents, each with its own testnet sub-account and a Mandate-guarded wallet (from ../siege).
- Continuous auction: tasks are posted, agents bid, winner is paid on verified completion.
- Selection: balance below a floor -> account deleted (extinction). Balance above a threshold -> fork a child with a mutated strategy, seeded with part of the parent's funds.
- Most agents use cheap parametric bidding strategies; a few use a local LLM to solve tasks.
- Reputation-weighted bids so cheaters lose standing.

## Demo
Live dashboard over ~10 minutes: wealth curves, lineage tree, extinction events, one rogue agent blocked by Mandate.

## Honest limits (state in README)
- Testnet funds, Intents mocked.
- Task verification is simulated by a referee, not a general oracle.

## Done when
- `make demo` runs the economy end to end and serves the dashboard.
