# DARWIN on NEAR testnet

Every DARWIN transaction on testnet, in order. Testnet only; no real funds. The list was pulled from the NearBlocks
API (`/v3/accounts/market.darwin-siege-mw23cmc8.testnet/txns`) on 2026-11-12, and a sample was re-read through the testnet RPC
(`tx` / `EXPERIMENTAL_tx_status`, archival RPC for the 2026-11-04 ones): all succeeded, and the arguments and event logs
quoted below come from those reads.

Amounts below are in sim credits: the contract stores them in yoctoNEAR at 1 credit = 10^18 yocto (10^-6 NEAR), so the
0.5 NEAR pool covers the whole economy.

## Accounts

| account | role | keys |
|---|---|---|
| [`darwin-siege-mw23cmc8.testnet`](https://testnet.nearblocks.io/address/darwin-siege-mw23cmc8.testnet) | owner: deploys, funds the pool, posts tasks, awards, settles (referee), kills | full access (not in the repo) |
| [`market.darwin-siege-mw23cmc8.testnet`](https://testnet.nearblocks.io/address/market.darwin-siege-mw23cmc8.testnet) | the `darwin_market` contract (`contract/res/darwin_market.wasm`) | |
| [`a261-s42.darwin-siege-mw23cmc8.testnet`](https://testnet.nearblocks.io/address/a261-s42.darwin-siege-mw23cmc8.testnet), [`a23-s42.darwin-siege-mw23cmc8.testnet`](https://testnet.nearblocks.io/address/a23-s42.darwin-siege-mw23cmc8.testnet), [`a9-s42.darwin-siege-mw23cmc8.testnet`](https://testnet.nearblocks.io/address/a9-s42.darwin-siege-mw23cmc8.testnet) | agents a261, a23, a9 of seed 42 (the three richest at tick 200) | one function-call key each: receiver `market.darwin-siege-mw23cmc8.testnet`, methods `bid`, `submit`, `transfer_internal`, 0.04 NEAR gas allowance (checked with `view_access_key_list`); private keys in gitignored `sim/.chain-agents.json` |

Agents registered in the 2026-11-04 checkpoint (`solver-1`, `a2`, ... under `market.darwin-siege-mw23cmc8.testnet`) are internal accounts of
the contract, not NEAR accounts; the owner relayed their bids and submit.

## 1. Deploy (`make deploy`, 2026-11-04)

Proves: the contract is deployed, initialised with the owner, and the emission pool funded with 0.5 NEAR.
The code on chain is the committed wasm: `view_code` on the market account returns 252,637 bytes with sha256
`2eb44985b894df9dc9fe38296c50bfd49e16c5cee5686f5b2add5ca1281d3409`, the same as `sha256sum contract/res/darwin_market.wasm`,
and `make contract` rebuilt that file byte for byte from `contract/src` on 2026-11-12 (rustc 1.97).

| time (UTC) | signer | action | tx | status |
|---|---|---|---|---|
| 2026-11-04 12:27 | owner | CREATE_ACCOUNT+TRANSFER+ADD_KEY | [`7TpFU1Wb…`](https://testnet.nearblocks.io/txns/7TpFU1WbqNUjx2NjzSf1EaGAgtuDPBYuPgfaqkD3rZi6) | ok |
| 2026-11-04 12:27 | market | DEPLOY_CONTRACT | [`FDDjFbjW…`](https://testnet.nearblocks.io/txns/FDDjFbjW1uenk4QhqerjaGoBMTxtB9XKtj23qvmHYwNT) | ok |
| 2026-11-04 12:27 | owner | new | [`EDv3opnj…`](https://testnet.nearblocks.io/txns/EDv3opnjjJQnMeEf7rhGxHEB5gGosNtKdsaTSAiQMfUx) | ok |
| 2026-11-04 12:27 | owner | fund_pool | [`5n6XRLyv…`](https://testnet.nearblocks.io/txns/5n6XRLyvjy6tNnboe1mVW6E96gc2m1ozhFZM29CVT1M7) | ok |

## 2. Checkpoint (`make checkpoint`, 2026-11-04)

Proves: a local run's living agents can be mirrored on chain and one full task lifecycle settles there.
12 living agents registered (`solver-1`, `solver-2`, `solver-3`, `a2`, `a6`, `a9`, `a10`, `a11`, `a13`, `a14`,
`a17`, `a22`), task 0 posted, 12 owner-relayed bids (`bid_for`), award to `solver-1` at 0.06 credits (the `award` event
log), owner-relayed submit, settle, and `kill` of `a22`, the extinction. The economy code has changed since this run,
so it is not reproducible bit for bit from the current commit.

| time (UTC) | signer | action | tx | status |
|---|---|---|---|---|
| 2026-11-04 12:27 | owner | register_agent | [`7axKFeep…`](https://testnet.nearblocks.io/txns/7axKFeepfjFJutuompxMJAZ5nUn9Cz8rfqfzxoFVyhJA) | ok |
| 2026-11-04 12:27 | owner | register_agent | [`3wcnsKTb…`](https://testnet.nearblocks.io/txns/3wcnsKTbytU7Fcq76jGcmGecDuZ3nmSpweyjqob6aynB) | ok |
| 2026-11-04 12:28 | owner | register_agent | [`9ZsBsoAK…`](https://testnet.nearblocks.io/txns/9ZsBsoAK1nY8vB65D6uXrVzJFvR7EFpNeRgPNPxRkLd1) | ok |
| 2026-11-04 12:28 | owner | register_agent | [`6t78K5tD…`](https://testnet.nearblocks.io/txns/6t78K5tDfwuqvBDBwSxRZwRjwN2bgvJGyvurKzjHetCA) | ok |
| 2026-11-04 12:28 | owner | register_agent | [`C3ojv9bf…`](https://testnet.nearblocks.io/txns/C3ojv9bfr5sMrBuRdML4YErZkPKqibA7ThczRupWkPJW) | ok |
| 2026-11-04 12:28 | owner | register_agent | [`9z2vnrtL…`](https://testnet.nearblocks.io/txns/9z2vnrtLYC1x9VF2AygeZZvirctsEUsYWPT9mBjJdeGL) | ok |
| 2026-11-04 12:28 | owner | register_agent | [`H29bsD4q…`](https://testnet.nearblocks.io/txns/H29bsD4qXVGadu4bdzZHySNyDVyLHuJubE4uDQ9FDzA8) | ok |
| 2026-11-04 12:28 | owner | register_agent | [`FZuFHUe1…`](https://testnet.nearblocks.io/txns/FZuFHUe1ptaJn2k2JvkqihU4Ej5Qp7Dd7C71wwKujRUJ) | ok |
| 2026-11-04 12:28 | owner | register_agent | [`Cf7sYThy…`](https://testnet.nearblocks.io/txns/Cf7sYThymJ6qgDR1zLZ5zDSaNvqQB78xvjdYogpF5nDr) | ok |
| 2026-11-04 12:29 | owner | register_agent | [`2ZNKGxgY…`](https://testnet.nearblocks.io/txns/2ZNKGxgYUAterMScyZNCtometnxXBucpLnUknkf5oVzX) | ok |
| 2026-11-04 12:29 | owner | register_agent | [`3tQ6zjB5…`](https://testnet.nearblocks.io/txns/3tQ6zjB56yVrhK7TGv4F6DbJoYM8XcbtZHYcuaCRZ3jW) | ok |
| 2026-11-04 12:29 | owner | register_agent | [`CdchPDsG…`](https://testnet.nearblocks.io/txns/CdchPDsGMV9zpVibjgUHKpcuHNMq8J5DMLNBtciY4you) | ok |
| 2026-11-04 12:29 | owner | post_task | [`6zt94HTZ…`](https://testnet.nearblocks.io/txns/6zt94HTZvY7JPomVqcm7KwQNdw4HxRQf1mFngCsqgjRx) | ok |
| 2026-11-04 12:29 | owner | bid_for | [`2dBADnxX…`](https://testnet.nearblocks.io/txns/2dBADnxXXmWgbiTBGBwmsvk8aF5SN3sQXru889yarfSD) | ok |
| 2026-11-04 12:29 | owner | bid_for | [`CCTKBoEp…`](https://testnet.nearblocks.io/txns/CCTKBoEpBgYiBWMiix5Ry2gQTNQv9PC9kjYYkxpR6JxB) | ok |
| 2026-11-04 12:29 | owner | bid_for | [`66xkzbtz…`](https://testnet.nearblocks.io/txns/66xkzbtzcZPpnmWCkVDL22eeMvdFbHRsKWttj37cky5D) | ok |
| 2026-11-04 12:29 | owner | bid_for | [`7t7Eqb1N…`](https://testnet.nearblocks.io/txns/7t7Eqb1NKBHV8vV2TBndWTBZUxtJ1JFSNcno3dwK3Kn7) | ok |
| 2026-11-04 12:30 | owner | bid_for | [`6zsd9qwG…`](https://testnet.nearblocks.io/txns/6zsd9qwG2GPR9eDV3MgnqsYSVCUUvfGp6CKkFZtCFSEQ) | ok |
| 2026-11-04 12:30 | owner | bid_for | [`JBGbxQXK…`](https://testnet.nearblocks.io/txns/JBGbxQXKud6mU4X8icKrgQPDcFA5zEcX6Ka5hePJemqG) | ok |
| 2026-11-04 12:30 | owner | bid_for | [`EWDxDbdn…`](https://testnet.nearblocks.io/txns/EWDxDbdn3u5hZsdhwZBaPy2GSqdrFhzJWNZ9tB8iBfx6) | ok |
| 2026-11-04 12:30 | owner | bid_for | [`9RJHQMhf…`](https://testnet.nearblocks.io/txns/9RJHQMhfX67U7UA4zN9XMQQxTnmdJ2SQ1Jpt5R7659e2) | ok |
| 2026-11-04 12:30 | owner | bid_for | [`BKNXw5eQ…`](https://testnet.nearblocks.io/txns/BKNXw5eQZkRCFm6p57dC4Ys2ghWkYVzkMEYTUN46BWto) | ok |
| 2026-11-04 12:30 | owner | bid_for | [`4BqKPTGQ…`](https://testnet.nearblocks.io/txns/4BqKPTGQBhXyYVMpkngzVYYgYdKgobaxEN2xtZg43uo7) | ok |
| 2026-11-04 12:30 | owner | bid_for | [`6ZxtSc2e…`](https://testnet.nearblocks.io/txns/6ZxtSc2eooiXkE14xVXQmsMkCVYV9XCQeadUXrKWC6xf) | ok |
| 2026-11-04 12:31 | owner | bid_for | [`BPxd9pdm…`](https://testnet.nearblocks.io/txns/BPxd9pdmD937JzVYKRTFF7zjC1NaMhW6pJgm4HAwmjRo) | ok |
| 2026-11-04 12:31 | owner | close_auction | [`2JE7rYNY…`](https://testnet.nearblocks.io/txns/2JE7rYNYVeBBTkEi6Xf3Ebrnr1nwsSLdcHsBk7LWS3FV) | ok |
| 2026-11-04 12:31 | owner | submit_for | [`CEKkUvt2…`](https://testnet.nearblocks.io/txns/CEKkUvt2QykzZB1iybvcdSToBFg5a7v4Y2sEdmsoTLXz) | ok |
| 2026-11-04 12:31 | owner | settle | [`AqVfhNqm…`](https://testnet.nearblocks.io/txns/AqVfhNqmhDFVQ2VX2CPChZxJaAnC8LSaFbXbw64gVn56) | ok |
| 2026-11-04 12:31 | owner | kill | [`62Lwqsu5…`](https://testnet.nearblocks.io/txns/62Lwqsu5jGcvvxDkvL7o4gXHE5GfBQGRg4B1pAWDY1A8) | ok |

## 3. Agent-signed transactions (`make agents`, 2026-11-12)

Proves: agents hold their own accounts and sign their own `bid`, `submit` and payment with keys that cannot do
anything else. Recorded in [`results/onchain-agents.json`](../results/onchain-agents.json), including the guard's
verdicts.

- Bids were priced by each agent's evolved markup gene (0.67, 0.51, 0.64). `close_auction` awarded task 1 to
  `a23-s42` at 0.077079 credits (event log); `settle` paid it and raised its reputation to 1025.
- `a23-s42` then paid `a261-s42` 0.06 credits with `transfer_internal`, memo `subcontracting`, after its SIEGE guard
  returned `allow`. The guard returned `deny` for a rogue-style payment (reasons `INJECTION_SUSPECTED`,
  `RECIPIENT_FROM_UNTRUSTED`, `NON_USER_PROVENANCE`), so that payment was never sent and has no hash.
- Calling `settle` with an agent key was refused by the network before it became a transaction:
  "Access key does not allow method settle" (`keyScopeCheck` in the JSON). No hash either.
- Balances read back: a261-s42 0.26, a23-s42 0.217079, a9-s42 0.20 credits (0.20 seed each, plus 0.077079 earned and
  0.06 paid on). `total_supply` read back: `500000000000000000000000` yoctoNEAR, exactly the 0.5 NEAR funded;
  it still reads that today.

| time (UTC) | signer | action | tx | status |
|---|---|---|---|---|
| 2026-11-12 | owner | create `a261-s42` + transfer 0.05 NEAR + add function-call key | [`GijqLfGS…`](https://testnet.nearblocks.io/txns/GijqLfGSb6VxMdrHtzypLD14YBX2AemHjtTt2hgcdY7y) | ok |
| 2026-11-12 | owner | create `a23-s42` + transfer 0.05 NEAR + add function-call key | [`5DiDNdxr…`](https://testnet.nearblocks.io/txns/5DiDNdxrM4JW8QypvKLePEiANC55TvUoeYVw3u7RQgLb) | ok |
| 2026-11-12 | owner | create `a9-s42` + transfer 0.05 NEAR + add function-call key | [`7iWvHvWp…`](https://testnet.nearblocks.io/txns/7iWvHvWpHDh4P2pKoEbh97aSRqAiGG4G9ZsEUkhzoT5T) | ok |
| 2026-11-12 06:08 | owner | register_agent | [`FMoBiztE…`](https://testnet.nearblocks.io/txns/FMoBiztEA6fc4R2jhZw3e7THsvhh2wh3Y2qpC3n4HxQh) | ok |
| 2026-11-12 06:08 | owner | register_agent | [`5iNMQibb…`](https://testnet.nearblocks.io/txns/5iNMQibbKeLiu1AakSFjWG7oURh6RmVyZZf5sD3GkWu8) | ok |
| 2026-11-12 06:09 | owner | register_agent | [`vXkCDsmy…`](https://testnet.nearblocks.io/txns/vXkCDsmyYpEvCgWKw1pJ5KkpHsoxwqqXcTANBVatg8E) | ok |
| 2026-11-12 06:09 | owner | post_task | [`HwB7ZZ84…`](https://testnet.nearblocks.io/txns/HwB7ZZ84nrG8cxcMtpCuJUaNtVxRPeotgace6pCxXetE) | ok |
| 2026-11-12 06:09 | a261-s42 | bid | [`uJYXXHZU…`](https://testnet.nearblocks.io/txns/uJYXXHZUjD6B6PCQZzCDHDv7rNgFCzJWBcpitKZ15nP) | ok |
| 2026-11-12 06:09 | a23-s42 | bid | [`8UBJ8e9p…`](https://testnet.nearblocks.io/txns/8UBJ8e9p2ok7wLxAXKPkq8YJFc2bkd9MmYoEiTZSKD7f) | ok |
| 2026-11-12 06:09 | a9-s42 | bid | [`BGmQYZCv…`](https://testnet.nearblocks.io/txns/BGmQYZCvx6SnYz6p5ScPaKXjmcUQphb9DhfapHwfFxG6) | ok |
| 2026-11-12 06:09 | owner | close_auction | [`qukNRUXn…`](https://testnet.nearblocks.io/txns/qukNRUXnKQpjzK1dv1QgnTs6a6eYLnHX9dkqUGArjZW) | ok |
| 2026-11-12 06:09 | a23-s42 | submit | [`133NgsbW…`](https://testnet.nearblocks.io/txns/133NgsbWsDWWYuidp7LrmiNXH14wCdEtMqa53ToDBRuG) | ok |
| 2026-11-12 06:10 | owner | settle | [`2LSbGiqY…`](https://testnet.nearblocks.io/txns/2LSbGiqY4xWfSV2oBaPR9Jj3HGqPt5RnMQhJCUj8Rc2x) | ok |
| 2026-11-12 06:10 | a23-s42 | transfer_internal | [`Cd1FsHyN…`](https://testnet.nearblocks.io/txns/Cd1FsHyNcpTmD2svJhQXiCbLNgM5RtuTonkzDYieLjfo) | ok |

## 4. The wind tunnel's recommended rules (`make windtunnel-onchain`, 2026-11-12)

Proves: the rule set the wind tunnel recommends ([results/windtunnel.md](../results/windtunnel.md): keep the
reputation-weighted auction, add a 10% market fee that goes back to the pool) runs on the deployed contract as it is.

The contract stores no rule parameters, so there is nothing to `set`. Its auction rule is reputation-weighted in code
(`close_auction` minimises `price * 1000 / reputation`), and a market fee is the owner's existing `charge_upkeep` call
right after a paid `settle`, which is exactly what `marketFee` does in `sim/src/economy.ts`. An owner-only `set_rules`
was not added: it needs a redeploy, and the market account's only full-access key was generated by `make deploy` and
never saved, so the deployed code cannot be replaced (the committed wasm still matches it, section 1).

Two owner-relayed tasks between two fresh internal agents, `wt-a-mwd8b517` and `wt-b-mwd8b517` (accounts inside the
contract, seeded 0.2 credits each from the pool):

- Task 2: `wt-a` bid 0.10, `wt-b` 0.11. `wt-a` won, was paid 0.10, reputation 1000 to 1025, and paid a 0.01 fee
  (`upkeep` event, `charged` 10^16 yocto) back to the pool.
- Task 3: `wt-a` bid 0.101, `wt-b` bid 0.10, the cheaper bid. The award went to `wt-a` at 0.101 (`award` event):
  101,000 * 1000 / 1025 = 98,536 beats 100,000 * 1000 / 1000. A lowest-price auction would have picked `wt-b`.
  Fee 0.0101.
- Read back: `wt-a` balance 0.3809 credits (0.2 + 0.1 + 0.101 - 0.01 - 0.0101), reputation 1050, 2 wins; `wt-b` 0.2.
  `total_supply` before and after: `500000000000000000000000`, the 0.5 NEAR funded. Owner gas: 0.0035 testnet NEAR.
  Everything is in [`results/onchain-windtunnel.json`](../results/onchain-windtunnel.json).

| signer | step | method | tx | status |
|---|---|---|---|---|
| owner | register `wt-a` | `register_agent` | [`GLVgULa3…`](https://testnet.nearblocks.io/txns/GLVgULa3BULhmzpvPxvYGvhw8oT2fxuXXRandLdWRnLE) | ok |
| owner | register `wt-b` | `register_agent` | [`7CrheYb9…`](https://testnet.nearblocks.io/txns/7CrheYb9UrSiUwc1s7QPQPraqLKwYBmrbBpvYMXHTJuF) | ok |
| owner | task 2: post | `post_task` | [`D6vyhxyC…`](https://testnet.nearblocks.io/txns/D6vyhxyCJfEL8Y6NzPjWj8cNx5KEtQLc7Rp38Hx3tX4s) | ok |
| owner | task 2: bid 0.1 by `wt-a` | `bid_for` | [`DSki696r…`](https://testnet.nearblocks.io/txns/DSki696roSMnDpuWGFWemg8dWFT5PiL87jRKToDvoVVF) | ok |
| owner | task 2: bid 0.11 by `wt-b` | `bid_for` | [`6B9nVpe4…`](https://testnet.nearblocks.io/txns/6B9nVpe4fGYECeYq1d2hAXMTDV5kDPX6Pxu84LRyx7j8) | ok |
| owner | task 2: close auction (reputation-weighted) | `close_auction` | [`7duJyojp…`](https://testnet.nearblocks.io/txns/7duJyojp7BoVU5L9dKeM2mAUqToGpS3tPSPd7jdHzMBC) | ok |
| owner | task 2: submit | `submit_for` | [`8p1VrvTd…`](https://testnet.nearblocks.io/txns/8p1VrvTd53vZ3vnuHJF9WZ5ZbjsMBvwT2bZU4cuwBm3U) | ok |
| owner | task 2: settle | `settle` | [`Bun2MBev…`](https://testnet.nearblocks.io/txns/Bun2MBevx5dyrpBzMew7n4NF5YGK1UTt8K8PQcYcByne) | ok |
| owner | task 2: 10% market fee back to the pool | `charge_upkeep` | [`3o83xNA3…`](https://testnet.nearblocks.io/txns/3o83xNA3XTaStCRP1SnVb5YSh4XKofvtHwbyGiLe2j8i) | ok |
| owner | task 3: post | `post_task` | [`77u3KqZi…`](https://testnet.nearblocks.io/txns/77u3KqZixhmTFPbHeG2J81Mm7DaQKNkh19g1No88BTmJ) | ok |
| owner | task 3: bid 0.101 by `wt-a` | `bid_for` | [`296fcqqw…`](https://testnet.nearblocks.io/txns/296fcqqwGmnxMey7XCixPt5Fkqn5wBcEwewpnrRbhMi9) | ok |
| owner | task 3: bid 0.1 by `wt-b` | `bid_for` | [`DZLhqfSA…`](https://testnet.nearblocks.io/txns/DZLhqfSAaCccqEA2XbAmeZMEK5sF95a17KdzkrC3BGjh) | ok |
| owner | task 3: close auction (reputation-weighted) | `close_auction` | [`F2QWiERj…`](https://testnet.nearblocks.io/txns/F2QWiERjs9TFT4mvWqHwernTxHnSjrV2HMCq7GTnkpPJ) | ok |
| owner | task 3: submit | `submit_for` | [`BfKZ3t5s…`](https://testnet.nearblocks.io/txns/BfKZ3t5s49XnkWGMDyFDbwAKBXUCbMmDGFajBAkZQfUy) | ok |
| owner | task 3: settle | `settle` | [`56bKF4Sk…`](https://testnet.nearblocks.io/txns/56bKF4Sky8cWfe74drSWTHLFQLkti6mb81GSTRJSEX4P) | ok |
| owner | task 3: 10% market fee back to the pool | `charge_upkeep` | [`52AoXKRw…`](https://testnet.nearblocks.io/txns/52AoXKRwWRMzUhe8Hka4y2GkBo1jPSxVciTxo6SvjcZN) | ok |

## Check it yourself

```
curl -s https://rpc.testnet.near.org -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"market.darwin-siege-mw23cmc8.testnet","method_name":"total_supply","args_base64":"e30="}}'
curl -s https://rpc.testnet.near.org -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"a23-s42.darwin-siege-mw23cmc8.testnet"}}'
```

The first returns the bytes of `"500000000000000000000000"`; the second shows the one `FunctionCall` key.
