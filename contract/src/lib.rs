use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

const REP_START: u32 = 1000;
const REP_MAX: u32 = 2000;
const REP_WIN: u32 = 25;
const REP_LOSS: u32 = 100;

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum Key {
    Agents,
    Tasks,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[near(serializers = [borsh, json])]
pub enum TaskStatus {
    Open,
    Awarded,
    Submitted,
    Settled,
    Expired,
}

#[derive(Clone)]
#[near(serializers = [borsh])]
pub struct Agent {
    balance: u128,
    reputation: u32,
    alive: bool,
    parent: Option<AccountId>,
    generation: u32,
    wins: u32,
    losses: u32,
}

#[derive(Clone)]
#[near(serializers = [borsh])]
pub struct Task {
    kind: String,
    reward: u128,
    deadline_ms: u64,
    status: TaskStatus,
    bids: Vec<(AccountId, u128)>,
    winner: Option<AccountId>,
    price: u128,
    answer_hash: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct AgentView {
    pub balance: U128,
    pub reputation: u32,
    pub alive: bool,
    pub parent: Option<AccountId>,
    pub generation: u32,
    pub wins: u32,
    pub losses: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct TaskView {
    pub kind: String,
    pub reward: U128,
    pub deadline_ms: u64,
    pub status: TaskStatus,
    pub bids: Vec<(AccountId, U128)>,
    pub winner: Option<AccountId>,
    pub answer_hash: Option<String>,
}

impl From<&Agent> for AgentView {
    fn from(a: &Agent) -> Self {
        AgentView {
            balance: U128(a.balance),
            reputation: a.reputation,
            alive: a.alive,
            parent: a.parent.clone(),
            generation: a.generation,
            wins: a.wins,
            losses: a.losses,
        }
    }
}

impl From<&Task> for TaskView {
    fn from(t: &Task) -> Self {
        TaskView {
            kind: t.kind.clone(),
            reward: U128(t.reward),
            deadline_ms: t.deadline_ms,
            status: t.status,
            bids: t.bids.iter().map(|(a, p)| (a.clone(), U128(*p))).collect(),
            winner: t.winner.clone(),
            answer_hash: t.answer_hash.clone(),
        }
    }
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    let e = json!({"standard":"darwin","version":"1.0.0","event":event,"data":data});
    env::log_str(&format!("EVENT_JSON:{}", e));
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Market {
    owner: AccountId,
    pool: u128,
    /// Rewards reserved for tasks that are not yet settled/expired.
    escrow: u128,
    next_task_id: u64,
    agents: IterableMap<AccountId, Agent>,
    tasks: LookupMap<u64, Task>,
}

#[near]
impl Market {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            pool: 0,
            escrow: 0,
            next_task_id: 0,
            agents: IterableMap::new(Key::Agents),
            tasks: LookupMap::new(Key::Tasks),
        }
    }

    // ---- admin / funding ----
    #[payable]
    pub fn fund_pool(&mut self) {
        self.assert_owner();
        self.pool += env::attached_deposit().as_yoctonear();
        emit("fund", json!({"amount": env::attached_deposit().as_yoctonear().to_string(), "pool": self.pool.to_string()}));
    }

    pub fn register_agent(&mut self, agent_id: AccountId, parent: Option<AccountId>, seed: U128) {
        self.assert_owner();
        require!(self.agents.get(&agent_id).is_none(), "agent exists");
        let generation = match &parent {
            Some(p) => self.agents.get(p).unwrap_or_else(|| env::panic_str("parent not found")).generation + 1,
            None => 0,
        };
        require!(self.pool >= seed.0, "insufficient pool");
        self.pool -= seed.0;
        self.insert_agent(agent_id.clone(), parent.clone(), generation, seed.0);
        emit("register", json!({"agent_id": agent_id, "parent": parent, "generation": generation, "seed": seed}));
    }

    pub fn fork(&mut self, parent: AccountId, child: AccountId, seed: U128) {
        self.assert_owner();
        require!(self.agents.get(&child).is_none(), "child exists");
        let p = self.agents.get(&parent).unwrap_or_else(|| env::panic_str("parent not found"));
        require!(p.alive, "parent dead");
        require!(p.balance >= seed.0, "insufficient parent balance");
        let generation = p.generation + 1;
        self.agents.get_mut(&parent).unwrap().balance -= seed.0;
        self.insert_agent(child.clone(), Some(parent.clone()), generation, seed.0);
        emit("fork", json!({"parent": parent, "child": child, "generation": generation, "seed": seed}));
    }

    // ---- tasks ----
    pub fn post_task(&mut self, kind: String, reward: U128, deadline_ms: u64) -> u64 {
        self.assert_owner();
        require!(self.pool >= reward.0, "insufficient pool");
        self.pool -= reward.0;
        self.escrow += reward.0;
        let id = self.next_task_id;
        self.next_task_id += 1;
        self.tasks.insert(
            id,
            Task { kind: kind.clone(), reward: reward.0, deadline_ms, status: TaskStatus::Open, bids: vec![], winner: None, price: 0, answer_hash: None },
        );
        emit("post", json!({"task_id": id, "kind": kind, "reward": reward, "deadline_ms": deadline_ms}));
        id
    }

    pub fn bid(&mut self, task_id: u64, price: U128) {
        let a = env::predecessor_account_id();
        self.do_bid(a, task_id, price.0);
    }

    pub fn bid_for(&mut self, agent_id: AccountId, task_id: u64, price: U128) {
        self.assert_owner();
        self.do_bid(agent_id, task_id, price.0);
    }

    pub fn close_auction(&mut self, task_id: u64) {
        self.assert_owner();
        let mut t = self.tasks.get(&task_id).unwrap_or_else(|| env::panic_str("no such task")).clone();
        require!(t.status == TaskStatus::Open, "task not open");
        let mut best: Option<(u128, AccountId, u128)> = None; // (score, id, price)
        for (a, p) in &t.bids {
            let ag = match self.agents.get(a) { Some(x) if x.alive => x, _ => continue };
            let score = p * 1000 / (ag.reputation.max(1) as u128);
            let better = match &best {
                None => true,
                Some((bs, bid, _)) => score < *bs || (score == *bs && a < bid),
            };
            if better { best = Some((score, a.clone(), *p)); }
        }
        match best {
            None => {
                t.status = TaskStatus::Expired;
                self.escrow -= t.reward;
                self.pool += t.reward;
                emit("expire", json!({"task_id": task_id, "reward": U128(t.reward)}));
            }
            Some((_, w, p)) => {
                t.status = TaskStatus::Awarded;
                t.winner = Some(w.clone());
                t.price = p;
                emit("award", json!({"task_id": task_id, "winner": w, "price": U128(p)}));
            }
        }
        self.tasks.insert(task_id, t);
    }

    pub fn submit(&mut self, task_id: u64, answer_hash: String) {
        let a = env::predecessor_account_id();
        self.do_submit(a, task_id, answer_hash);
    }

    pub fn submit_for(&mut self, agent_id: AccountId, task_id: u64, answer_hash: String) {
        self.assert_owner();
        self.do_submit(agent_id, task_id, answer_hash);
    }

    pub fn settle(&mut self, task_id: u64, correct: bool) {
        self.assert_owner();
        let mut t = self.tasks.get(&task_id).unwrap_or_else(|| env::panic_str("no such task")).clone();
        require!(t.status == TaskStatus::Submitted, "task not submitted");
        let w = t.winner.clone().unwrap();
        self.escrow -= t.reward;
        let ag = self.agents.get_mut(&w).unwrap();
        if correct {
            ag.balance += t.price;
            ag.reputation = (ag.reputation + REP_WIN).min(REP_MAX);
            ag.wins += 1;
            self.pool += t.reward - t.price;
        } else {
            ag.reputation = ag.reputation.saturating_sub(REP_LOSS);
            ag.losses += 1;
            self.pool += t.reward;
        }
        let rep = ag.reputation;
        t.status = TaskStatus::Settled;
        self.tasks.insert(task_id, t.clone());
        emit("settle", json!({"task_id": task_id, "winner": w, "correct": correct, "paid": U128(if correct { t.price } else { 0 }), "reputation": rep}));
    }

    // ---- agent economy ----
    pub fn transfer_internal(&mut self, to: AccountId, amount: U128, memo: String) {
        let from = env::predecessor_account_id();
        self.do_transfer(from, to, amount.0, memo);
    }

    pub fn transfer_for(&mut self, from: AccountId, to: AccountId, amount: U128, memo: String) {
        self.assert_owner();
        self.do_transfer(from, to, amount.0, memo);
    }

    pub fn charge_upkeep(&mut self, agent_id: AccountId, amount: U128) {
        self.assert_owner();
        let ag = self.agents.get_mut(&agent_id).unwrap_or_else(|| env::panic_str("agent not found"));
        let c = ag.balance.min(amount.0);
        ag.balance -= c;
        self.pool += c;
        emit("upkeep", json!({"agent_id": agent_id, "charged": U128(c)}));
    }

    pub fn kill(&mut self, agent_id: AccountId) {
        self.assert_owner();
        let ag = self.agents.get_mut(&agent_id).unwrap_or_else(|| env::panic_str("agent not found"));
        require!(ag.alive, "already dead");
        let b = ag.balance;
        ag.balance = 0;
        ag.alive = false;
        self.pool += b;
        emit("kill", json!({"agent_id": agent_id, "reclaimed": U128(b)}));
    }

    // ---- views ----
    pub fn get_agent(&self, agent_id: AccountId) -> Option<AgentView> {
        self.agents.get(&agent_id).map(AgentView::from)
    }

    pub fn get_task(&self, task_id: u64) -> Option<TaskView> {
        self.tasks.get(&task_id).map(TaskView::from)
    }

    pub fn list_agents(&self, from_index: u64, limit: u64) -> Vec<(AccountId, AgentView)> {
        self.agents
            .iter()
            .skip(from_index as usize)
            .take(limit as usize)
            .map(|(k, v)| (k.clone(), AgentView::from(v)))
            .collect()
    }

    pub fn get_pool(&self) -> U128 {
        U128(self.pool)
    }

    /// pool + escrowed task rewards + sum of agent balances. Constant except fund_pool.
    pub fn total_supply(&self) -> U128 {
        U128(self.pool + self.escrow + self.agents.values().map(|a| a.balance).sum::<u128>())
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }
}

impl Market {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn insert_agent(&mut self, id: AccountId, parent: Option<AccountId>, generation: u32, balance: u128) {
        self.agents.insert(
            id,
            Agent { balance, reputation: REP_START, alive: true, parent, generation, wins: 0, losses: 0 },
        );
    }

    fn do_bid(&mut self, agent: AccountId, task_id: u64, price: u128) {
        let alive = self.agents.get(&agent).map(|a| a.alive).unwrap_or(false);
        require!(alive, "agent not alive");
        let t = self.tasks.get_mut(&task_id).unwrap_or_else(|| env::panic_str("no such task"));
        require!(t.status == TaskStatus::Open, "task not open");
        require!(price <= t.reward, "price exceeds reward");
        require!(!t.bids.iter().any(|(a, _)| *a == agent), "already bid");
        t.bids.push((agent.clone(), price));
        emit("bid", json!({"task_id": task_id, "agent_id": agent, "price": U128(price)}));
    }

    fn do_submit(&mut self, agent: AccountId, task_id: u64, answer_hash: String) {
        let t = self.tasks.get_mut(&task_id).unwrap_or_else(|| env::panic_str("no such task"));
        require!(t.status == TaskStatus::Awarded, "task not awarded");
        require!(t.winner.as_ref() == Some(&agent), "not the winner");
        t.status = TaskStatus::Submitted;
        t.answer_hash = Some(answer_hash);
    }

    fn do_transfer(&mut self, from: AccountId, to: AccountId, amount: u128, memo: String) {
        require!(from != to, "self transfer");
        let f = self.agents.get(&from).unwrap_or_else(|| env::panic_str("sender not found"));
        require!(f.alive, "sender not alive");
        let t = self.agents.get(&to).unwrap_or_else(|| env::panic_str("receiver not found"));
        require!(t.alive, "receiver not alive");
        require!(f.balance >= amount, "insufficient balance");
        self.agents.get_mut(&from).unwrap().balance -= amount;
        self.agents.get_mut(&to).unwrap().balance += amount;
        emit("transfer", json!({"from": from, "to": to, "amount": U128(amount), "memo": memo}));
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::NearToken;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    fn acc(s: &str) -> AccountId { s.parse().unwrap() }

    fn ctx(who: &str, deposit: u128) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(acc(who))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .build());
    }

    fn setup() -> Market {
        ctx("owner.near", 0);
        let mut m = Market::new(acc("owner.near"));
        ctx("owner.near", 1_000_000);
        m.fund_pool();
        ctx("owner.near", 0);
        m
    }

    fn sup(m: &Market) -> u128 { m.total_supply().0 }

    #[test]
    fn lifecycle_correct() {
        let mut m = setup();
        m.register_agent(acc("a.near"), None, U128(1000));
        let id = m.post_task("math".into(), U128(500), 99);
        ctx("a.near", 0);
        m.bid(id, U128(300));
        ctx("owner.near", 0);
        m.close_auction(id);
        ctx("a.near", 0);
        m.submit(id, "h".into());
        ctx("owner.near", 0);
        m.settle(id, true);
        let a = m.get_agent(acc("a.near")).unwrap();
        assert_eq!(a.balance.0, 1300);
        assert_eq!(a.reputation, 1025);
        assert_eq!(a.wins, 1);
        assert_eq!(m.get_pool().0, 1_000_000 - 1000 - 300);
        assert_eq!(m.get_task(id).unwrap().status, TaskStatus::Settled);
        assert_eq!(sup(&m), 1_000_000);
    }

    #[test]
    fn reputation_weighted_award() {
        let mut m = setup();
        m.register_agent(acc("hi.near"), None, U128(0));
        m.register_agent(acc("lo.near"), None, U128(0));
        // drop lo's reputation to 900 via a wrong answer
        let t0 = m.post_task("x".into(), U128(10), 0);
        m.bid_for(acc("lo.near"), t0, U128(1));
        m.close_auction(t0);
        m.submit_for(acc("lo.near"), t0, "h".into());
        m.settle(t0, false);
        assert_eq!(m.get_agent(acc("lo.near")).unwrap().reputation, 900);
        let t = m.post_task("x".into(), U128(1000), 0);
        // hi: 100*1000/1000=100 ; lo: 95*1000/900=105 -> hi wins despite higher price
        m.bid_for(acc("hi.near"), t, U128(100));
        m.bid_for(acc("lo.near"), t, U128(95));
        m.close_auction(t);
        assert_eq!(m.get_task(t).unwrap().winner, Some(acc("hi.near")));
    }

    #[test]
    fn tie_break_by_id() {
        let mut m = setup();
        m.register_agent(acc("b.near"), None, U128(0));
        m.register_agent(acc("a.near"), None, U128(0));
        let t = m.post_task("x".into(), U128(100), 0);
        m.bid_for(acc("b.near"), t, U128(50));
        m.bid_for(acc("a.near"), t, U128(50));
        m.close_auction(t);
        assert_eq!(m.get_task(t).unwrap().winner, Some(acc("a.near")));
    }

    #[test]
    fn wrong_answer() {
        let mut m = setup();
        m.register_agent(acc("a.near"), None, U128(100));
        let t = m.post_task("x".into(), U128(500), 0);
        m.bid_for(acc("a.near"), t, U128(400));
        m.close_auction(t);
        m.submit_for(acc("a.near"), t, "bad".into());
        m.settle(t, false);
        let a = m.get_agent(acc("a.near")).unwrap();
        assert_eq!((a.balance.0, a.reputation, a.losses), (100, 900, 1));
        assert_eq!(m.get_pool().0, 1_000_000 - 100);
        assert_eq!(sup(&m), 1_000_000);
    }

    #[test]
    fn expiry_no_bids() {
        let mut m = setup();
        let t = m.post_task("x".into(), U128(500), 0);
        assert_eq!(m.get_pool().0, 999_500);
        m.close_auction(t);
        assert_eq!(m.get_task(t).unwrap().status, TaskStatus::Expired);
        assert_eq!(m.get_pool().0, 1_000_000);
    }

    #[test]
    fn fork_and_kill() {
        let mut m = setup();
        m.register_agent(acc("p.near"), None, U128(1000));
        m.fork(acc("p.near"), acc("c.near"), U128(400));
        let c = m.get_agent(acc("c.near")).unwrap();
        assert_eq!((c.balance.0, c.generation, c.parent.clone()), (400, 1, Some(acc("p.near"))));
        assert_eq!(m.get_agent(acc("p.near")).unwrap().balance.0, 600);
        m.register_agent(acc("g.near"), Some(acc("c.near")), U128(10));
        assert_eq!(m.get_agent(acc("g.near")).unwrap().generation, 2);
        m.kill(acc("c.near"));
        let c = m.get_agent(acc("c.near")).unwrap();
        assert!(!c.alive);
        assert_eq!(c.balance.0, 0);
        assert_eq!(m.get_pool().0, 1_000_000 - 1000 - 10 + 400);
        assert_eq!(sup(&m), 1_000_000);
        assert_eq!(m.list_agents(0, 10).len(), 3);
    }

    #[test]
    #[should_panic(expected = "insufficient balance")]
    fn transfer_insufficient() {
        let mut m = setup();
        m.register_agent(acc("a.near"), None, U128(10));
        m.register_agent(acc("b.near"), None, U128(0));
        ctx("a.near", 0);
        m.transfer_internal(acc("b.near"), U128(11), "x".into());
    }

    #[test]
    fn transfer_ok_and_upkeep() {
        let mut m = setup();
        m.register_agent(acc("a.near"), None, U128(10));
        m.register_agent(acc("b.near"), None, U128(0));
        ctx("a.near", 0);
        m.transfer_internal(acc("b.near"), U128(4), "sub".into());
        ctx("owner.near", 0);
        m.charge_upkeep(acc("a.near"), U128(100));
        assert_eq!(m.get_agent(acc("a.near")).unwrap().balance.0, 0);
        assert_eq!(m.get_agent(acc("b.near")).unwrap().balance.0, 4);
        assert_eq!(sup(&m), 1_000_000);
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn non_owner_rejected() {
        let mut m = setup();
        ctx("evil.near", 0);
        m.register_agent(acc("a.near"), None, U128(1));
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn non_owner_cannot_settle() {
        let mut m = setup();
        ctx("evil.near", 0);
        m.settle(0, true);
    }

    /// Agent-signed path used by `make agents`: each agent account signs its own bid, submit and payment.
    /// The predecessor is the agent; nobody else can bid, submit or pay as it.
    #[test]
    fn agent_signed_lifecycle_and_payment() {
        let mut m = setup();
        m.register_agent(acc("a1.owner.near"), None, U128(1000));
        m.register_agent(acc("a2.owner.near"), None, U128(1000));
        let id = m.post_task("arith".into(), U128(500), 99);
        ctx("a1.owner.near", 0);
        m.bid(id, U128(200));
        ctx("a2.owner.near", 0);
        m.bid(id, U128(300));
        ctx("owner.near", 0);
        m.close_auction(id);
        assert_eq!(m.get_task(id).unwrap().winner, Some(acc("a1.owner.near")));
        // The loser cannot submit for the winner.
        ctx("a2.owner.near", 0);
        let r = catch_unwind(AssertUnwindSafe(|| m.submit(id, "h".into())));
        assert!(r.is_err());
        ctx("a1.owner.near", 0);
        m.submit(id, "h".into());
        ctx("owner.near", 0);
        m.settle(id, true);
        ctx("a1.owner.near", 0);
        m.transfer_internal(acc("a2.owner.near"), U128(150), "subcontracting".into());
        assert_eq!(m.get_agent(acc("a1.owner.near")).unwrap().balance.0, 1000 + 200 - 150);
        assert_eq!(m.get_agent(acc("a2.owner.near")).unwrap().balance.0, 1150);
        assert_eq!(sup(&m), 1_000_000);
    }

    #[test]
    #[should_panic(expected = "agent not alive")]
    fn unregistered_account_cannot_bid() {
        let mut m = setup();
        let id = m.post_task("arith".into(), U128(500), 99);
        ctx("stranger.near", 0);
        m.bid(id, U128(100));
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn agent_cannot_use_relayed_methods() {
        let mut m = setup();
        m.register_agent(acc("a1.owner.near"), None, U128(1000));
        m.register_agent(acc("a2.owner.near"), None, U128(1000));
        ctx("a1.owner.near", 0);
        m.transfer_for(acc("a2.owner.near"), acc("a1.owner.near"), U128(500), "steal".into());
    }

    #[test]
    fn conservation_random() {
        let mut m = setup();
        let names: Vec<AccountId> = (0..8).map(|i| acc(&format!("ag{i}.near"))).collect();
        let mut s: u64 = 0x1234_5678_9abc_def1;
        let mut rnd = move |n: u64| { s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); (s >> 33) % n };
        for step in 0..400 {
            let a = names[rnd(8) as usize].clone();
            let b = names[rnd(8) as usize].clone();
            let tid = rnd(40);
            let amt = U128(rnd(3000) as u128);
            let op = rnd(11);
            let as_agent = rnd(2) == 0;
            let r = catch_unwind(AssertUnwindSafe(|| {
                ctx("owner.near", 0);
                match op {
                    0 => m.register_agent(a, None, amt),
                    1 => m.fork(a, b, amt),
                    2 => { m.post_task("k".into(), amt, 0); }
                    3 => { if as_agent { ctx(a.as_str(), 0); m.bid(tid, amt) } else { m.bid_for(a, tid, amt) } }
                    4 => m.close_auction(tid),
                    5 => m.submit_for(a, tid, "h".into()),
                    6 => m.settle(tid, rnd(3) != 0),
                    7 => { if as_agent { ctx(a.as_str(), 0); m.transfer_internal(b, amt, "m".into()) } else { m.transfer_for(a, b, amt, "m".into()) } }
                    8 => m.charge_upkeep(a, amt),
                    9 => { if rnd(4) == 0 { m.kill(a) } }
                    _ => m.fork(a, b, amt),
                }
            }));
            let _ = r;
            ctx("owner.near", 0);
            assert_eq!(sup(&m), 1_000_000, "violated at step {step} op {op}");
        }
        assert!(m.list_agents(0, 100).len() > 1);
    }
}
