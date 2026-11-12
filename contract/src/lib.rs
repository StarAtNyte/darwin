//! DARWIN market v2: the agent economy's ledger, with the referee and the keeper taken out of the trusted path.
//!
//! What v2 enforces on chain (v1, still deployed at market.<owner>, trusted the owner for all of it):
//!
//! * Guarded payments. `transfer_internal` is signed by the paying agent's own key, and pays only with an
//!   approval signed by the registered guard key (the SIEGE Mandate guard signs only payments it allows):
//!
//!     message   = "darwin-market-v2|<network>|<market id>|<from>|<to>|<amount>|<nonce>|<expires_at ns>"
//!     guard_sig = ed25519(guard secret key, message), checked with env::ed25519_verify
//!
//!   Each (from, nonce) is single use, approvals expire, and per-agent caps (per payment, per window) hold
//!   whatever the guard signed. A refusal does not panic: it returns `Outcome { ok: false, reason }` and emits a
//!   NEP-297 `transfer_refused` event, so a stolen function-call key that skips the guard is visible on chain.
//!
//! * Verified settlement. The owner posts a task with `answer_hash = sha256(task_id as u64 LE || canonical answer)`
//!   (canonical = trimmed, ASCII lower case). After the bid window anyone may `close_auction` (the contract
//!   computes the reputation-weighted award). The winner `submit`s its answer; the contract hashes it and records
//!   it only if it matches (a wrong answer is refused with an event, at most MAX_SUBMITS tries). After the deadline
//!   anyone may `settle`: verified pays the winner, anything else refunds the reward to the pool.
//!   Limit: the hash is public, so an answer from a small space (a sentiment label, a small integer) can be found
//!   by hashing candidates, which is the same as solving it. Use it for answers that are hard to guess.
//!
//! * Permissionless lifecycle. Anyone may `charge_upkeep(agent)` once per epoch (block time) and `kill(agent)`
//!   once its balance is below the floor.
//!
//! Still owner-only: registering agents, forking (the child's account is created off chain), posting tasks and
//! setting the rules and guard key. Owner admin calls need 1 yoctoNEAR, which a function-call key cannot attach.
//!
//! Arguments and results are Borsh (no serde_json in the wasm, which keeps the storage stake down); events stay
//! JSON. `sim/src/v2.ts` encodes calls. State carries a version; `migrate` is the upgrade hook.

use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{assert_one_yocto, env, near, require, AccountId, BorshStorageKey, CurveType, PanicOnDefault, PublicKey};

pub const STATE_VERSION: u32 = 2;
pub const MESSAGE_TAG: &str = "darwin-market-v2";
pub const REP_START: u32 = 1000;
pub const REP_MAX: u32 = 2000;
pub const REP_WIN: u32 = 25;
pub const REP_LOSS: u32 = 100;
pub const MAX_SUBMITS: u8 = 3;
const MAX_MEMO: usize = 64;
const MAX_KIND: usize = 32;
const MAX_ANSWER: usize = 256;
const MAX_BIDS: usize = 64;

// Reason codes (transfer_refused / submit_refused).
pub const NOT_AGENT: &str = "NOT_AGENT";
pub const BAD_AMOUNT: &str = "BAD_AMOUNT";
pub const BAD_MEMO: &str = "BAD_MEMO";
pub const BAD_SIGNATURE: &str = "BAD_SIGNATURE";
pub const APPROVAL_EXPIRED: &str = "APPROVAL_EXPIRED";
pub const EXPIRY_TOO_FAR: &str = "EXPIRY_TOO_FAR";
pub const NONCE_REUSED: &str = "NONCE_REUSED";
pub const BAD_RECEIVER: &str = "BAD_RECEIVER";
pub const PER_TX_CAP: &str = "PER_TX_CAP";
pub const WINDOW_CAP: &str = "WINDOW_CAP";
pub const INSUFFICIENT_BALANCE: &str = "INSUFFICIENT_BALANCE";
pub const WRONG_ANSWER: &str = "WRONG_ANSWER";
pub const TOO_MANY_SUBMITS: &str = "TOO_MANY_SUBMITS";

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum Key {
    Agents,
    Tasks,
    Nonces,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[near(serializers = [borsh])]
pub enum TaskStatus {
    Open,
    Awarded,
    Verified,
    Settled,
    Expired,
}

/// Market rules. Amounts are in the ledger's unit (yoctoNEAR of the funded pool); times in ns of block time.
#[derive(Clone, Debug, PartialEq)]
#[near(serializers = [borsh])]
pub struct Rules {
    /// Charged by `charge_upkeep`, at most once per agent per epoch.
    pub upkeep: u128,
    pub epoch_ns: u64,
    /// `kill` is allowed below this balance.
    pub floor: u128,
    /// Market fee on a verified settle, in basis points of the price, back to the pool.
    pub fee_bps: u16,
    /// Per agent: largest single payment, and total payments per window.
    pub per_tx_cap: u128,
    pub window_cap: u128,
    pub window_ns: u64,
    /// Longest approval lifetime accepted.
    pub max_ttl_ns: u64,
}

#[derive(Clone, Debug, PartialEq)]
#[near(serializers = [borsh])]
pub struct Agent {
    pub balance: u128,
    pub reputation: u32,
    pub alive: bool,
    pub parent: Option<AccountId>,
    pub generation: u32,
    pub wins: u32,
    pub losses: u32,
    pub last_upkeep_epoch: Option<u64>,
    pub window: u64,
    pub window_spent: u128,
}

#[derive(Clone, Debug, PartialEq)]
#[near(serializers = [borsh])]
pub struct Task {
    pub kind: String,
    pub reward: u128,
    pub answer_hash: [u8; 32],
    pub bid_close_ns: u64,
    pub deadline_ns: u64,
    pub status: TaskStatus,
    pub bids: Vec<(AccountId, u128)>,
    pub winner: Option<AccountId>,
    pub price: u128,
    pub answer: Option<String>,
    pub submits: u8,
}

#[derive(Debug, PartialEq)]
#[near(serializers = [borsh])]
pub struct Outcome {
    pub ok: bool,
    pub reason: Option<String>,
}

impl Outcome {
    fn ok() -> Self {
        Outcome { ok: true, reason: None }
    }
    fn no(r: &str) -> Self {
        Outcome { ok: false, reason: Some(r.to_string()) }
    }
}

pub fn canonical_message(network: &str, contract: &str, from: &str, to: &str, amount: u128, nonce: u64, expires_at: u64) -> String {
    format!("{MESSAGE_TAG}|{network}|{contract}|{from}|{to}|{amount}|{nonce}|{expires_at}")
}

/// Trimmed, ASCII lower case: the same normalisation the sim's referee applies.
pub fn canonical_answer(a: &str) -> String {
    a.trim().to_ascii_lowercase()
}

/// sha256(task_id as u64 little endian || canonical answer bytes).
pub fn answer_hash(task_id: u64, answer: &str) -> [u8; 32] {
    let mut buf = task_id.to_le_bytes().to_vec();
    buf.extend_from_slice(canonical_answer(answer).as_bytes());
    env::sha256_array(&buf)
}

/// NEP-297 event. Values are account ids, decimal numbers, reason codes or hex: nothing needs escaping, except
/// memos and kinds, which are restricted to [a-z0-9 _-] on the way in.
fn emit(event: &str, data: &str) {
    env::log_str(&format!(r#"EVENT_JSON:{{"standard":"darwin","version":"2.0.0","event":"{event}","data":[{{{data}}}]}}"#));
}

fn plain(s: &str, max: usize) -> bool {
    s.len() <= max && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b' ' || b == b'_' || b == b'-')
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Market {
    version: u32,
    owner: AccountId,
    guard_pk: PublicKey,
    network: String,
    rules: Rules,
    pool: u128,
    /// Rewards reserved for tasks that are not yet settled or expired.
    escrow: u128,
    next_task_id: u64,
    agents: IterableMap<AccountId, Agent>,
    tasks: LookupMap<u64, Task>,
    used_nonces: LookupSet<(AccountId, u64)>,
}

#[near]
impl Market {
    #[init]
    #[private]
    pub fn new(
        #[serializer(borsh)] owner: AccountId,
        #[serializer(borsh)] guard_pk: PublicKey,
        #[serializer(borsh)] network: String,
        #[serializer(borsh)] rules: Rules,
    ) -> Self {
        require!(guard_pk.curve_type() == CurveType::ED25519, "guard key must be ed25519");
        Self::check_rules(&rules);
        Self {
            version: STATE_VERSION,
            owner,
            guard_pk,
            network,
            rules,
            pool: 0,
            escrow: 0,
            next_task_id: 0,
            agents: IterableMap::new(Key::Agents),
            tasks: LookupMap::new(Key::Tasks),
            used_nonces: LookupSet::new(Key::Nonces),
        }
    }

    /// Upgrade hook: deploy new code and call this in the same transaction (signed by the market account's
    /// full-access key). It reads the stored state, refuses a newer layout, and stamps the current version.
    /// A future layout change adds a `MarketV2` copy of today's struct here and converts it field by field.
    #[init(ignore_state)]
    #[private]
    pub fn migrate() -> Self {
        let mut s: Market = env::state_read().unwrap_or_else(|| env::panic_str("no state"));
        require!(s.version <= STATE_VERSION, "state is newer than this code");
        let from = s.version;
        s.version = STATE_VERSION;
        emit("migrate", &format!(r#""from":{from},"to":{STATE_VERSION}"#));
        s
    }

    // ---------------------------------------------------------------- owner

    /// Anyone may add NEAR to the emission pool (it only grows the supply the market pays out of).
    #[payable]
    pub fn fund_pool(&mut self) {
        let d = env::attached_deposit().as_yoctonear();
        self.pool += d;
        emit("fund", &format!(r#""amount":"{d}","pool":"{}""#, self.pool));
    }

    #[payable]
    pub fn set_rules(&mut self, #[serializer(borsh)] rules: Rules) {
        self.assert_owner_admin();
        Self::check_rules(&rules);
        self.rules = rules;
        emit("rules_set", "");
    }

    #[payable]
    pub fn set_guard(&mut self, #[serializer(borsh)] guard_pk: PublicKey) {
        self.assert_owner_admin();
        require!(guard_pk.curve_type() == CurveType::ED25519, "guard key must be ed25519");
        self.guard_pk = guard_pk;
        emit("guard_set", "");
    }

    pub fn register_agent(&mut self, #[serializer(borsh)] agent_id: AccountId, #[serializer(borsh)] parent: Option<AccountId>, #[serializer(borsh)] seed: u128) {
        self.assert_owner();
        require!(self.agents.get(&agent_id).is_none(), "agent exists");
        let generation = match &parent {
            Some(p) => self.agents.get(p).unwrap_or_else(|| env::panic_str("parent not found")).generation + 1,
            None => 0,
        };
        require!(self.pool >= seed, "insufficient pool");
        self.pool -= seed;
        self.insert_agent(agent_id.clone(), parent, generation, seed);
        emit("register", &format!(r#""agent_id":"{agent_id}","generation":{generation},"seed":"{seed}""#));
    }

    /// Owner-relayed: the child's NEAR account is created off chain, so the owner names it.
    pub fn fork(&mut self, #[serializer(borsh)] parent: AccountId, #[serializer(borsh)] child: AccountId, #[serializer(borsh)] seed: u128) {
        self.assert_owner();
        require!(self.agents.get(&child).is_none(), "child exists");
        let p = self.agents.get(&parent).unwrap_or_else(|| env::panic_str("parent not found"));
        require!(p.alive, "parent dead");
        require!(p.balance >= seed, "insufficient parent balance");
        let generation = p.generation + 1;
        self.agents.get_mut(&parent).unwrap().balance -= seed;
        self.insert_agent(child.clone(), Some(parent.clone()), generation, seed);
        emit("fork", &format!(r#""parent":"{parent}","child":"{child}","generation":{generation},"seed":"{seed}""#));
    }

    #[result_serializer(borsh)]
    pub fn post_task(
        &mut self,
        #[serializer(borsh)] kind: String,
        #[serializer(borsh)] reward: u128,
        #[serializer(borsh)] answer_hash: [u8; 32],
        #[serializer(borsh)] bid_close_ns: u64,
        #[serializer(borsh)] deadline_ns: u64,
    ) -> u64 {
        self.assert_owner();
        require!(plain(&kind, MAX_KIND), "bad kind");
        require!(reward > 0, "zero reward");
        require!(bid_close_ns > env::block_timestamp() && deadline_ns > bid_close_ns, "bad windows");
        require!(self.pool >= reward, "insufficient pool");
        self.pool -= reward;
        self.escrow += reward;
        let id = self.next_task_id;
        self.next_task_id += 1;
        emit("post", &format!(r#""task_id":{id},"kind":"{kind}","reward":"{reward}","answer_hash":"{}","bid_close_ns":"{bid_close_ns}","deadline_ns":"{deadline_ns}""#, hex(&answer_hash)));
        self.tasks.insert(id, Task { kind, reward, answer_hash, bid_close_ns, deadline_ns, status: TaskStatus::Open, bids: vec![], winner: None, price: 0, answer: None, submits: 0 });
        id
    }

    // ---------------------------------------------------------------- agents (signed by the agent's own key)

    pub fn bid(&mut self, #[serializer(borsh)] task_id: u64, #[serializer(borsh)] price: u128) {
        let agent = env::predecessor_account_id();
        require!(self.agents.get(&agent).map(|a| a.alive).unwrap_or(false), "agent not alive");
        let t = self.tasks.get_mut(&task_id).unwrap_or_else(|| env::panic_str("no such task"));
        require!(t.status == TaskStatus::Open, "task not open");
        require!(env::block_timestamp() < t.bid_close_ns, "bid window closed");
        require!(price > 0 && price <= t.reward, "bad price");
        require!(t.bids.len() < MAX_BIDS, "too many bids");
        require!(!t.bids.iter().any(|(a, _)| *a == agent), "already bid");
        t.bids.push((agent.clone(), price));
        emit("bid", &format!(r#""task_id":{task_id},"agent_id":"{agent}","price":"{price}""#));
    }

    /// The winner submits its answer. Recorded only if it hashes to the posted answer_hash.
    #[result_serializer(borsh)]
    pub fn submit(&mut self, #[serializer(borsh)] task_id: u64, #[serializer(borsh)] answer: String) -> Outcome {
        let agent = env::predecessor_account_id();
        let t = self.tasks.get_mut(&task_id).unwrap_or_else(|| env::panic_str("no such task"));
        require!(t.status == TaskStatus::Awarded, "task not awarded");
        require!(t.winner.as_ref() == Some(&agent), "not the winner");
        require!(env::block_timestamp() < t.deadline_ns, "deadline passed");
        require!(answer.len() <= MAX_ANSWER, "answer too long");
        if t.submits >= MAX_SUBMITS {
            emit("submit_refused", &format!(r#""task_id":{task_id},"agent_id":"{agent}","reason":"{TOO_MANY_SUBMITS}""#));
            return Outcome::no(TOO_MANY_SUBMITS);
        }
        t.submits += 1;
        if answer_hash(task_id, &answer) != t.answer_hash {
            emit("submit_refused", &format!(r#""task_id":{task_id},"agent_id":"{agent}","reason":"{WRONG_ANSWER}","try":{}"#, t.submits));
            return Outcome::no(WRONG_ANSWER);
        }
        t.status = TaskStatus::Verified;
        t.answer = Some(canonical_answer(&answer));
        emit("submit", &format!(r#""task_id":{task_id},"agent_id":"{agent}","verified":true"#));
        Outcome::ok()
    }

    /// Pay another live agent under a guard approval. Never panics on a refusal.
    #[result_serializer(borsh)]
    pub fn transfer_internal(
        &mut self,
        #[serializer(borsh)] to: AccountId,
        #[serializer(borsh)] amount: u128,
        #[serializer(borsh)] memo: String,
        #[serializer(borsh)] nonce: u64,
        #[serializer(borsh)] expires_at: u64,
        #[serializer(borsh)] guard_sig: Vec<u8>,
    ) -> Outcome {
        let from = env::predecessor_account_id();
        match self.check_transfer(&from, &to, amount, &memo, nonce, expires_at, &guard_sig) {
            Ok(()) => {
                self.agents.get_mut(&from).unwrap().balance -= amount;
                self.agents.get_mut(&to).unwrap().balance += amount;
                emit("transfer", &format!(r#""from":"{from}","to":"{to}","amount":"{amount}","nonce":"{nonce}","memo":"{memo}""#));
                Outcome::ok()
            }
            Err(reason) => {
                let memo = if plain(&memo, MAX_MEMO) { memo.as_str() } else { "" };
                emit("transfer_refused", &format!(r#""from":"{from}","to":"{to}","amount":"{amount}","nonce":"{nonce}","memo":"{memo}","reason":"{reason}""#));
                Outcome::no(reason)
            }
        }
    }

    /// An agent pays part of its balance back to the pool (the sim's compute cost and fork fee).
    pub fn burn(&mut self, #[serializer(borsh)] amount: u128) {
        let agent = env::predecessor_account_id();
        let a = self.agents.get_mut(&agent).unwrap_or_else(|| env::panic_str("agent not found"));
        require!(a.alive, "agent not alive");
        require!(a.balance >= amount, "insufficient balance");
        a.balance -= amount;
        self.pool += amount;
        emit("burn", &format!(r#""agent_id":"{agent}","amount":"{amount}""#));
    }

    // ---------------------------------------------------------------- anyone

    /// After the bid window: award to the live bid with the lowest price * 1000 / reputation (tie: lower id),
    /// or expire the task and refund the pool if no live agent bid.
    pub fn close_auction(&mut self, #[serializer(borsh)] task_id: u64) {
        let mut t = self.tasks.get(&task_id).unwrap_or_else(|| env::panic_str("no such task")).clone();
        require!(t.status == TaskStatus::Open, "task not open");
        require!(env::block_timestamp() >= t.bid_close_ns, "bid window open");
        let mut best: Option<(u128, AccountId, u128)> = None;
        for (a, p) in &t.bids {
            let ag = match self.agents.get(a) {
                Some(x) if x.alive => x,
                _ => continue,
            };
            let score = p * 1000 / (ag.reputation.max(1) as u128);
            let better = match &best {
                None => true,
                Some((bs, bid, _)) => score < *bs || (score == *bs && a < bid),
            };
            if better {
                best = Some((score, a.clone(), *p));
            }
        }
        let by = env::predecessor_account_id();
        match best {
            None => {
                t.status = TaskStatus::Expired;
                self.escrow -= t.reward;
                self.pool += t.reward;
                emit("expire", &format!(r#""task_id":{task_id},"reward":"{}","by":"{by}""#, t.reward));
            }
            Some((_, w, p)) => {
                t.status = TaskStatus::Awarded;
                emit("award", &format!(r#""task_id":{task_id},"winner":"{w}","price":"{p}","by":"{by}""#));
                t.winner = Some(w);
                t.price = p;
            }
        }
        self.tasks.insert(task_id, t);
    }

    /// After the deadline: pay a verified, live winner (less the market fee); otherwise refund the reward to the
    /// pool and dock the winner's reputation.
    pub fn settle(&mut self, #[serializer(borsh)] task_id: u64) {
        let mut t = self.tasks.get(&task_id).unwrap_or_else(|| env::panic_str("no such task")).clone();
        require!(t.status == TaskStatus::Awarded || t.status == TaskStatus::Verified, "task not settleable");
        require!(env::block_timestamp() >= t.deadline_ns, "before deadline");
        let w = t.winner.clone().unwrap();
        self.escrow -= t.reward;
        let fee_bps = self.rules.fee_bps as u128;
        let ag = self.agents.get_mut(&w).unwrap();
        let verified = t.status == TaskStatus::Verified;
        let (paid, fee) = if verified && ag.alive {
            let fee = t.price * fee_bps / 10_000;
            ag.balance += t.price - fee;
            ag.reputation = (ag.reputation + REP_WIN).min(REP_MAX);
            ag.wins += 1;
            (t.price, fee)
        } else {
            ag.reputation = ag.reputation.saturating_sub(REP_LOSS);
            ag.losses += 1;
            (0, 0)
        };
        let rep = ag.reputation;
        self.pool += t.reward - paid + fee;
        t.status = TaskStatus::Settled;
        self.tasks.insert(task_id, t);
        emit("settle", &format!(r#""task_id":{task_id},"winner":"{w}","verified":{verified},"paid":"{paid}","fee":"{fee}","reputation":{rep},"by":"{}""#, env::predecessor_account_id()));
    }

    /// Charge one epoch's upkeep (or the whole balance, if less) to a live agent. Once per agent per epoch.
    pub fn charge_upkeep(&mut self, #[serializer(borsh)] agent_id: AccountId) {
        let epoch = env::block_timestamp() / self.rules.epoch_ns;
        let upkeep = self.rules.upkeep;
        let a = self.agents.get_mut(&agent_id).unwrap_or_else(|| env::panic_str("agent not found"));
        require!(a.alive, "agent not alive");
        require!(a.last_upkeep_epoch != Some(epoch), "upkeep already charged this epoch");
        a.last_upkeep_epoch = Some(epoch);
        let c = a.balance.min(upkeep);
        a.balance -= c;
        self.pool += c;
        emit("upkeep", &format!(r#""agent_id":"{agent_id}","charged":"{c}","epoch":{epoch},"by":"{}""#, env::predecessor_account_id()));
    }

    /// Delete an agent whose balance is below the floor; its balance returns to the pool.
    pub fn kill(&mut self, #[serializer(borsh)] agent_id: AccountId) {
        let floor = self.rules.floor;
        let a = self.agents.get_mut(&agent_id).unwrap_or_else(|| env::panic_str("agent not found"));
        require!(a.alive, "already dead");
        require!(a.balance < floor, "balance above floor");
        let b = a.balance;
        a.balance = 0;
        a.alive = false;
        self.pool += b;
        emit("kill", &format!(r#""agent_id":"{agent_id}","reclaimed":"{b}","by":"{}""#, env::predecessor_account_id()));
    }

    // ---------------------------------------------------------------- views (Borsh results)

    #[result_serializer(borsh)]
    pub fn get_agent(&self, #[serializer(borsh)] agent_id: AccountId) -> Option<Agent> {
        self.agents.get(&agent_id).cloned()
    }

    #[result_serializer(borsh)]
    pub fn get_task(&self, #[serializer(borsh)] task_id: u64) -> Option<Task> {
        self.tasks.get(&task_id).cloned()
    }

    #[result_serializer(borsh)]
    pub fn get_pool(&self) -> u128 {
        self.pool
    }

    /// pool + escrowed rewards + every agent's balance. Changes only with fund_pool.
    #[result_serializer(borsh)]
    pub fn total_supply(&self) -> u128 {
        self.pool + self.escrow + self.agents.values().map(|a| a.balance).sum::<u128>()
    }

    #[result_serializer(borsh)]
    pub fn get_rules(&self) -> Rules {
        self.rules.clone()
    }

    /// (version, owner, guard key, network, next task id, agent count)
    #[result_serializer(borsh)]
    pub fn get_meta(&self) -> (u32, AccountId, PublicKey, String, u64, u32) {
        (self.version, self.owner.clone(), self.guard_pk.clone(), self.network.clone(), self.next_task_id, self.agents.len())
    }

    #[result_serializer(borsh)]
    pub fn nonce_used(&self, #[serializer(borsh)] agent_id: AccountId, #[serializer(borsh)] nonce: u64) -> bool {
        self.used_nonces.contains(&(agent_id, nonce))
    }

    /// The exact text the guard must sign, for clients to cross-check their encoding.
    #[result_serializer(borsh)]
    pub fn approval_message(
        &self,
        #[serializer(borsh)] from: AccountId,
        #[serializer(borsh)] to: AccountId,
        #[serializer(borsh)] amount: u128,
        #[serializer(borsh)] nonce: u64,
        #[serializer(borsh)] expires_at: u64,
    ) -> String {
        canonical_message(&self.network, env::current_account_id().as_str(), from.as_str(), to.as_str(), amount, nonce, expires_at)
    }

    #[result_serializer(borsh)]
    pub fn hash_answer(&self, #[serializer(borsh)] task_id: u64, #[serializer(borsh)] answer: String) -> [u8; 32] {
        answer_hash(task_id, &answer)
    }
}

fn hex(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    b.iter().flat_map(|x| [H[(x >> 4) as usize] as char, H[(x & 15) as usize] as char]).collect()
}

impl Market {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn assert_owner_admin(&self) {
        assert_one_yocto();
        self.assert_owner();
    }

    fn check_rules(r: &Rules) {
        require!(r.epoch_ns > 0 && r.window_ns > 0 && r.max_ttl_ns > 0, "zero period");
        require!(r.fee_bps <= 10_000, "fee_bps above 10000");
        require!(r.per_tx_cap <= r.window_cap, "per_tx_cap above window_cap");
    }

    fn insert_agent(&mut self, id: AccountId, parent: Option<AccountId>, generation: u32, balance: u128) {
        self.agents.insert(
            id,
            Agent { balance, reputation: REP_START, alive: true, parent, generation, wins: 0, losses: 0, last_upkeep_epoch: None, window: 0, window_spent: 0 },
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn check_transfer(&mut self, from: &AccountId, to: &AccountId, amount: u128, memo: &str, nonce: u64, expires_at: u64, sig: &[u8]) -> Result<(), &'static str> {
        if !self.agents.get(from).map(|a| a.alive).unwrap_or(false) {
            return Err(NOT_AGENT);
        }
        if amount == 0 {
            return Err(BAD_AMOUNT);
        }
        if !plain(memo, MAX_MEMO) {
            return Err(BAD_MEMO);
        }
        // Signature before anything stateful: an unsigned attempt changes nothing and burns no nonce.
        let sig: &[u8; 64] = sig.try_into().map_err(|_| BAD_SIGNATURE)?;
        let pk: &[u8; 32] = self.guard_pk.as_bytes()[1..].try_into().map_err(|_| BAD_SIGNATURE)?;
        let msg = canonical_message(&self.network, env::current_account_id().as_str(), from.as_str(), to.as_str(), amount, nonce, expires_at);
        if !env::ed25519_verify(sig, msg.as_bytes(), pk) {
            return Err(BAD_SIGNATURE);
        }
        let now = env::block_timestamp();
        if now >= expires_at {
            return Err(APPROVAL_EXPIRED);
        }
        if expires_at - now > self.rules.max_ttl_ns {
            return Err(EXPIRY_TOO_FAR);
        }
        let key = (from.clone(), nonce);
        if self.used_nonces.contains(&key) {
            return Err(NONCE_REUSED);
        }
        // A genuine, fresh approval is single use from here on, whether or not the rest lets it pay.
        self.used_nonces.insert(key);
        if to == from || !self.agents.get(to).map(|a| a.alive).unwrap_or(false) {
            return Err(BAD_RECEIVER);
        }
        if amount > self.rules.per_tx_cap {
            return Err(PER_TX_CAP);
        }
        let window = now / self.rules.window_ns;
        let window_cap = self.rules.window_cap;
        let f = self.agents.get_mut(from).unwrap();
        let spent = if f.window == window { f.window_spent } else { 0 };
        if spent + amount > window_cap {
            return Err(WINDOW_CAP);
        }
        if f.balance < amount {
            return Err(INSUFFICIENT_BALANCE);
        }
        f.window = window;
        f.window_spent = spent + amount;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
