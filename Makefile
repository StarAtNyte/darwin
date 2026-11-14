
.PHONY: sync-siege install demo headless seeds ablation windtunnel test-rules-grid test contract deploy checkpoint agents windtunnel-onchain deploy-v2 run-v2 upgrade-v2 settler-key
install:
	cd sim && npm install
sync-siege:      ## refresh vendor/siege from a SIEGE checkout (default ../siege)
	scripts/sync-siege.sh
demo:            ## run the economy live and serve the dashboard on http://localhost:8787
	cd sim && node --import tsx src/main.ts
headless:        ## fast run, prints metrics (TICKS=2000 SEED=7 make headless)
	cd sim && node --import tsx src/headless.ts
seeds:           ## 30 seeds x Gaussian mutation, no LLM: mean, range, 95% CI -> results/seeds-gaussian.md
	cd sim && node --import tsx src/experiment.ts seeds
ablation:        ## Gaussian vs LLM-guided vs mixed mutation on 5 seeds -> results/ablation.md (replays the committed cache; live calls only on misses)
	cd sim && NEAR_LLM_BUDGET_FILE=$${NEAR_LLM_BUDGET_FILE:-$$HOME/.darwin-llm-spend.json} NEAR_LLM_BUDGET_USD=$${NEAR_LLM_BUDGET_USD:-2.5} node --import tsx src/experiment.ts ablation
windtunnel:      ## 6 market rule sets x 30 seeds, no LLM: outcomes and paired tests vs baseline -> results/windtunnel.md
	cd sim && node --import tsx src/windtunnel.ts
test-rules-grid: ## "Test your own rules": all 128 dashboard combinations x 5 seeds, no LLM -> results/test-rules.json (~2-3 min on 4 workers)
	cd sim && node --import tsx src/testrules.ts grid
test:
	cd sim && node --import tsx --test test/*.test.ts && npx tsc --noEmit
	cd contract && cargo test --quiet
contract:        ## builds contract/res/darwin_market_v2.wasm
	cd contract && $(MAKE) build
deploy-v2:       ## v2 market at market2.<NEAR_ACCOUNT>; keys to sim/.chain-v2.json (gitignored, 0600)
	cd sim && node --import tsx src/chain2.ts deploy
run-v2:          ## one autonomous lifecycle on the v2 market -> results/onchain-v2.json
	cd sim && node --import tsx src/chain2.ts run
upgrade-v2:      ## redeploy contract/res/darwin_market_v2.wasm and call migrate() with the saved market key
	cd sim && node --import tsx src/chain2.ts upgrade
settler-key:     ## live settler: a function-call key (market2, transfer_internal only) saved to .env, never printed
	scripts/make-settler-key.sh
# v1 targets below run against the v1 market (market.<NEAR_ACCOUNT>), kept as history.
deploy:          ## v1; needs NEAR_ACCOUNT + NEAR_PRIVATE_KEY (testnet)
	cd sim && node --import tsx src/chain.ts deploy
checkpoint:
	cd sim && node --import tsx src/chain.ts checkpoint 300
agents:          ## agent-signed txs: per-agent testnet accounts with function-call keys (needs NEAR_ACCOUNT + NEAR_PRIVATE_KEY)
	cd sim && node --import tsx src/chain.ts agents 200 3
windtunnel-onchain: ## the wind tunnel's recommended rules (reputation auction + 10% fee) on the deployed contract (needs NEAR_ACCOUNT + NEAR_PRIVATE_KEY)
	cd sim && node --import tsx src/chain.ts windtunnel
