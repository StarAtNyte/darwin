RUSTFLAGS_WASM = -C link-arg=-s -C target-cpu=mvp

.PHONY: test build
test:
	cargo test

build:
	RUSTFLAGS="$(RUSTFLAGS_WASM)" cargo build --target wasm32-unknown-unknown --release
	mkdir -p res
	cp target/wasm32-unknown-unknown/release/darwin_market.wasm res/darwin_market.wasm
	@ls -l res/darwin_market.wasm
