SHELL := /bin/bash
# --cfg near makes near-sdk use the host functions (sha256 etc.) instead of compiling software fallbacks into the wasm.
RUSTFLAGS_WASM = -C link-arg=-s -C target-cpu=mvp --cfg near
# wasm-opt (binaryen 123) shrinks the wasm ~20% and lowers bulk-memory/sign-ext ops to MVP. Uses wasm-opt from PATH,
# else the npm binaryen package; if neither works the unoptimised wasm is copied (it will not match the committed one).
WASM_OPT ?= $(shell command -v wasm-opt 2>/dev/null || echo "npx -y -p binaryen@123.0.0 wasm-opt")
OUT = target/wasm32-unknown-unknown/release/darwin_market.wasm

.PHONY: test build
test:
	cargo test --quiet 2>&1 | grep -v '^EVENT_JSON' | grep -E 'test result|panicked|error' ; test $${PIPESTATUS[0]} -eq 0

# v2 only. v1 (deployed at market.<owner>, res/darwin_market.wasm) was built from commit d5a74b4.
build:
	RUSTFLAGS="$(RUSTFLAGS_WASM)" cargo build --target wasm32-unknown-unknown --release
	mkdir -p res
	$(WASM_OPT) -Oz --enable-bulk-memory-opt --llvm-memory-copy-fill-lowering --signext-lowering $(OUT) -o res/darwin_market_v2.wasm \
	  || cp $(OUT) res/darwin_market_v2.wasm
	@ls -l res/darwin_market_v2.wasm
