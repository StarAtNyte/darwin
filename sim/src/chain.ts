// Testnet bridge for the darwin_market contract.
//
//   NEAR_ACCOUNT=you.testnet NEAR_PRIVATE_KEY=ed25519:... npx tsx src/chain.ts deploy
//   NEAR_ACCOUNT=you.testnet NEAR_PRIVATE_KEY=ed25519:... npx tsx src/chain.ts checkpoint [ticks]
//
// deploy:     creates market.<you>.testnet, deploys res/darwin_market.wasm, calls new(owner=you), funds pool.
// checkpoint: runs the economy locally, then settles a checkpoint on testnet: registers every living agent
//             (as internal accounts of the contract), and replays one full sampled task lifecycle
//             (post -> bid_for x N -> close_auction -> submit_for -> settle) plus every extinction. It then
//             reads total_supply back to show conservation held on chain.
// Honest label: the economy runs at simulation speed locally; testnet holds checkpoints, not every tick.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { Economy } from "./economy.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.NEAR_RPC ?? "https://rpc.testnet.near.org";
const WASM = path.resolve(here, "../../contract/res/darwin_market.wasm");
const STATE = path.resolve(here, "../.chain-state.json");
const NEAR = 10n ** 24n;

function owner() {
  const id = process.env.NEAR_ACCOUNT, key = process.env.NEAR_PRIVATE_KEY as KeyPairString | undefined;
  if (!id || !key) throw new Error("set NEAR_ACCOUNT and NEAR_PRIVATE_KEY (testnet). Fund it from https://docs.near.org/getting-started/faucet");
  return new Account(id, new JsonRpcProvider({ url: RPC }), key);
}

async function deploy() {
  const me = owner();
  const kp = KeyPair.fromRandom("ed25519");
  const marketId = `market.${me.accountId}`;
  await me.createSubAccount({ accountOrPrefix: "market", publicKey: kp.getPublicKey().toString(), nearToTransfer: 4n * NEAR });
  const market = new Account(marketId, new JsonRpcProvider({ url: RPC }), kp.toString() as KeyPairString);
  await market.deployContract(new Uint8Array(fs.readFileSync(WASM)));
  await me.callFunction({ contractId: marketId, methodName: "new", args: { owner: me.accountId } });
  await me.callFunction({ contractId: marketId, methodName: "fund_pool", args: {}, deposit: NEAR / 2n });
  fs.writeFileSync(STATE, JSON.stringify({ marketId, deployedAt: new Date().toISOString() }, null, 2));
  console.log(`deployed ${marketId}; https://testnet.nearblocks.io/address/${marketId}`);
}

const short = (id: string) => id.replace(".darwin.testnet", "").replace(/[^a-z0-9-_]/g, "-");

async function checkpoint(ticks: number) {
  const me = owner();
  const { marketId } = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const call = (methodName: string, args: Record<string, unknown>) => me.callFunction({ contractId: marketId, methodName, args, gas: 100_000_000_000_000n });
  const view = (method: string, args: Record<string, unknown> = {}) => new JsonRpcProvider({ url: RPC }).callFunction({ contractId: marketId, method, args });

  const eco = new Economy({ seed: Number(process.env.SEED ?? 42) });
  for (let i = 0; i < ticks; i++) await eco.step();
  // Contract amounts are yocto; 1 sim credit (1e6 micro) = 1e-6 NEAR on chain, so the 0.5 NEAR pool covers it.
  const scale = (micro: number) => (BigInt(micro) * 10n ** 12n).toString();
  const living = eco.alive().filter((a) => a.role === "parametric" || a.role === "solver").slice(0, 12);
  const ids = living.map((a) => `${short(a.id)}.${marketId}`);
  for (const id of ids) {
    try {
      await call("register_agent", { agent_id: id, parent: null, seed: scale(200_000) });
    } catch (e) {
      if (!String(e).includes("exists")) throw e;
    }
  }
  const taskId = await call("post_task", { kind: "arith", reward: scale(150_000), deadline_ms: Date.now() + 3_600_000 });
  for (const [i, id] of ids.entries()) await call("bid_for", { agent_id: id, task_id: taskId, price: scale(60_000 + i * 5_000) });
  await call("close_auction", { task_id: taskId });
  const task: any = await view("get_task", { task_id: taskId });
  await call("submit_for", { agent_id: task.winner, task_id: taskId, answer_hash: "sha256:checkpoint" });
  await call("settle", { task_id: taskId, correct: true });
  const poorest = ids[ids.length - 1];
  await call("kill", { agent_id: poorest });
  console.log(`checkpoint at tick ${ticks}: ${ids.length} agents mirrored, task ${taskId} won by ${task.winner}, ${poorest} went extinct on chain`);
  console.log(`total_supply on chain: ${await view("total_supply")}  (pool ${await view("get_pool")})`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "deploy") await deploy();
else if (cmd === "checkpoint") await checkpoint(Number(arg ?? 300));
else console.log("usage: chain.ts deploy | checkpoint [ticks]");
