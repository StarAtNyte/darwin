.PHONY: install demo headless test contract deploy checkpoint
install:
	cd sim && npm install
	cd ../siege && npm install
demo:            ## run the economy live and serve the dashboard on http://localhost:8787
	cd sim && npx tsx src/main.ts
headless:        ## fast run, prints metrics (TICKS=2000 SEED=7 make headless)
	cd sim && npx tsx src/headless.ts
test:
	cd sim && node --import tsx --test test/*.test.ts && npx tsc --noEmit
	cd contract && cargo test --quiet
contract:
	cd contract && $(MAKE) build
deploy:          ## needs NEAR_ACCOUNT + NEAR_PRIVATE_KEY (testnet)
	cd sim && npx tsx src/chain.ts deploy
checkpoint:
	cd sim && npx tsx src/chain.ts checkpoint 300
