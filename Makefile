
.PHONY: sync-siege install demo headless seeds ablation test contract deploy checkpoint agents
install:
	cd sim && npm install
sync-siege:      ## refresh vendor/siege from a SIEGE checkout (default ../siege)
	scripts/sync-siege.sh
demo:            ## run the economy live and serve the dashboard on http://localhost:8787
	cd sim && npx tsx src/main.ts
headless:        ## fast run, prints metrics (TICKS=2000 SEED=7 make headless)
	cd sim && npx tsx src/headless.ts
seeds:           ## 10 seeds x Gaussian mutation, no LLM: mean, range, 95% CI -> results/seeds-gaussian.md
	cd sim && npx tsx src/experiment.ts seeds
ablation:        ## Gaussian vs LLM-guided vs mixed mutation on 5 seeds -> results/ablation.md (replays the committed cache; live calls only on misses)
	cd sim && NEAR_LLM_BUDGET_FILE=$${NEAR_LLM_BUDGET_FILE:-$$HOME/.near-hackathon-llm-spend-darwin.json} NEAR_LLM_BUDGET_USD=$${NEAR_LLM_BUDGET_USD:-2.5} npx tsx src/experiment.ts ablation
test:
	cd sim && node --import tsx --test test/*.test.ts && npx tsc --noEmit
	cd contract && cargo test --quiet
contract:
	cd contract && $(MAKE) build
deploy:          ## needs NEAR_ACCOUNT + NEAR_PRIVATE_KEY (testnet)
	cd sim && npx tsx src/chain.ts deploy
checkpoint:
	cd sim && npx tsx src/chain.ts checkpoint 300
agents:          ## agent-signed txs: per-agent testnet accounts with function-call keys (needs NEAR_ACCOUNT + NEAR_PRIVATE_KEY)
	cd sim && npx tsx src/chain.ts agents 200 3
