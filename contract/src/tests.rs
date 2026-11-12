use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, NearToken};
use std::panic::{catch_unwind, AssertUnwindSafe};

const MARKET: &str = "market2.owner.testnet";
const T0: u64 = 1_800_000_000_000_000_000; // ns
const SEC: u64 = 1_000_000_000;
const SUPPLY: u128 = 1_000_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn guard() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}
fn pk_of(k: &SigningKey) -> PublicKey {
    PublicKey::from_parts(CurveType::ED25519, k.verifying_key().to_bytes().to_vec()).unwrap()
}

fn at(who: &str, now: u64, deposit: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc(MARKET))
        .predecessor_account_id(acc(who))
        .signer_account_id(acc(who))
        .block_timestamp(now)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .build());
}

fn rules() -> Rules {
    Rules { upkeep: 6_000, epoch_ns: 60 * SEC, floor: 120_000, fee_bps: 0, per_tx_cap: 400_000, window_cap: 1_000_000, window_ns: 3600 * SEC, max_ttl_ns: 3600 * SEC }
}

/// Owner funds the pool and registers a1, a2 (1M each) and poor (100k, below the 120k floor).
fn setup() -> Market {
    at(MARKET, T0, 0);
    let mut m = Market::new(acc("owner.testnet"), pk_of(&guard()), "testnet".into(), rules());
    at("owner.testnet", T0, SUPPLY);
    m.fund_pool();
    at("owner.testnet", T0, 0);
    m.register_agent(acc("a1.testnet"), None, 1_000_000);
    m.register_agent(acc("a2.testnet"), None, 1_000_000);
    m.register_agent(acc("poor.testnet"), None, 100_000);
    m
}

fn sup(m: &Market) -> u128 {
    m.total_supply()
}
fn bal(m: &Market, a: &str) -> u128 {
    m.get_agent(acc(a)).unwrap().balance
}

fn sig_with(k: &SigningKey, network: &str, contract: &str, from: &str, to: &str, amount: u128, nonce: u64, exp: u64) -> Vec<u8> {
    k.sign(canonical_message(network, contract, from, to, amount, nonce, exp).as_bytes()).to_bytes().to_vec()
}
fn sig(from: &str, to: &str, amount: u128, nonce: u64, exp: u64) -> Vec<u8> {
    sig_with(&guard(), "testnet", MARKET, from, to, amount, nonce, exp)
}
fn pay(m: &mut Market, now: u64, from: &str, to: &str, amount: u128, nonce: u64, exp: u64, s: Vec<u8>) -> Outcome {
    at(from, now, 0);
    m.transfer_internal(acc(to), amount, "subcontracting".into(), nonce, exp, s)
}
fn refused(o: &Outcome, r: &str) {
    assert_eq!(o, &Outcome { ok: false, reason: Some(r.into()) });
}
fn panics<F: FnOnce()>(f: F, msg: &str) {
    let e = catch_unwind(AssertUnwindSafe(f)).expect_err("expected a panic");
    let s = e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
    assert!(s.contains(msg), "panic {s:?} does not contain {msg:?}");
}

/// Owner posts a task (bid window 10 s, deadline 20 s after T0) whose answer is "42".
fn post(m: &mut Market, reward: u128) -> u64 {
    at("owner.testnet", T0, 0);
    let id = m.next_task_id;
    m.post_task("arith".into(), reward, answer_hash(id, "42"), T0 + 10 * SEC, T0 + 20 * SEC)
}

#[test]
fn golden_vectors_match_typescript() {
    // Same values as sim/test/v2.test.ts, so the Rust and TypeScript encoders cannot drift apart.
    let msg = canonical_message("testnet", MARKET, "a1.testnet", "a2.testnet", 60_000, 7, 1_800_000_060_000_000_000);
    assert_eq!(msg, "darwin-market-v2|testnet|market2.owner.testnet|a1.testnet|a2.testnet|60000|7|1800000060000000000");
    let b64 = near_sdk::base64::Engine::encode(&near_sdk::base64::engine::general_purpose::STANDARD, guard().sign(msg.as_bytes()).to_bytes());
    assert_eq!(b64, include_str!("../vectors/sig.txt").trim());
    assert_eq!(hex(&answer_hash(3, " Positive ")), include_str!("../vectors/answer_hash.txt").trim());
    assert_eq!(answer_hash(3, " Positive "), answer_hash(3, "positive"));
    assert_ne!(answer_hash(3, "positive"), answer_hash(4, "positive"));
}

#[test]
fn verified_lifecycle_is_permissionless() {
    let mut m = setup();
    let id = post(&mut m, 500_000);
    at("a1.testnet", T0 + SEC, 0);
    m.bid(id, 300_000);
    at("a2.testnet", T0 + SEC, 0);
    m.bid(id, 400_000);
    // A stranger closes the auction and settles: no owner involved after the post.
    at("keeper.testnet", T0 + 10 * SEC, 0);
    m.close_auction(id);
    assert_eq!(m.get_task(id).unwrap().winner, Some(acc("a1.testnet")));
    at("a1.testnet", T0 + 11 * SEC, 0);
    assert_eq!(m.submit(id, "  42 ".into()), Outcome::ok());
    assert_eq!(m.get_task(id).unwrap().status, TaskStatus::Verified);
    at("keeper.testnet", T0 + 20 * SEC, 0);
    m.settle(id);
    let a = m.get_agent(acc("a1.testnet")).unwrap();
    assert_eq!((a.balance, a.reputation, a.wins), (1_300_000, 1025, 1));
    assert_eq!(m.get_task(id).unwrap().status, TaskStatus::Settled);
    assert_eq!(sup(&m), SUPPLY);
}

#[test]
fn wrong_answer_refused_then_settle_refunds() {
    let mut m = setup();
    let id = post(&mut m, 500_000);
    at("a1.testnet", T0 + SEC, 0);
    m.bid(id, 300_000);
    at("x.testnet", T0 + 10 * SEC, 0);
    m.close_auction(id);
    let pool = m.get_pool();
    at("a1.testnet", T0 + 11 * SEC, 0);
    refused(&m.submit(id, "41".into()), WRONG_ANSWER);
    assert!(get_logs().iter().any(|l| l.contains("submit_refused") && l.contains(WRONG_ANSWER)));
    assert_eq!(m.get_task(id).unwrap().status, TaskStatus::Awarded);
    refused(&m.submit(id, "40".into()), WRONG_ANSWER);
    refused(&m.submit(id, "39".into()), WRONG_ANSWER);
    // Tries are bounded: even the right answer is refused after MAX_SUBMITS wrong ones.
    refused(&m.submit(id, "42".into()), TOO_MANY_SUBMITS);
    at("x.testnet", T0 + 20 * SEC, 0);
    m.settle(id);
    let a = m.get_agent(acc("a1.testnet")).unwrap();
    assert_eq!((a.balance, a.reputation, a.losses), (1_000_000, 900, 1));
    assert_eq!(m.get_pool(), pool + 500_000);
    assert_eq!(sup(&m), SUPPLY);
}

#[test]
fn only_the_winner_submits_before_the_deadline() {
    let mut m = setup();
    let id = post(&mut m, 500_000);
    at("a1.testnet", T0 + SEC, 0);
    m.bid(id, 300_000);
    at("x.testnet", T0 + 10 * SEC, 0);
    m.close_auction(id);
    at("a2.testnet", T0 + 11 * SEC, 0);
    panics(|| { m.submit(id, "42".into()); }, "not the winner");
    at("a1.testnet", T0 + 20 * SEC, 0);
    panics(|| { m.submit(id, "42".into()); }, "deadline passed");
}

#[test]
fn settle_before_deadline_refused() {
    let mut m = setup();
    let id = post(&mut m, 500_000);
    at("a1.testnet", T0 + SEC, 0);
    m.bid(id, 300_000);
    at("x.testnet", T0 + 10 * SEC, 0);
    m.close_auction(id);
    at("a1.testnet", T0 + 11 * SEC, 0);
    m.submit(id, "42".into());
    at("x.testnet", T0 + 20 * SEC - 1, 0);
    panics(|| m.settle(id), "before deadline");
}

#[test]
fn double_settle_refused() {
    let mut m = setup();
    let id = post(&mut m, 500_000);
    at("a1.testnet", T0 + SEC, 0);
    m.bid(id, 300_000);
    at("x.testnet", T0 + 10 * SEC, 0);
    m.close_auction(id);
    at("x.testnet", T0 + 20 * SEC, 0);
    m.settle(id);
    panics(|| m.settle(id), "task not settleable");
    assert_eq!(sup(&m), SUPPLY);
}

#[test]
fn auction_windows_enforced() {
    let mut m = setup();
    let id = post(&mut m, 500_000);
    at("x.testnet", T0 + 9 * SEC, 0);
    panics(|| m.close_auction(id), "bid window open");
    at("a1.testnet", T0 + 10 * SEC, 0);
    panics(|| m.bid(id, 1), "bid window closed");
    at("stranger.testnet", T0 + SEC, 0);
    panics(|| m.bid(id, 1), "agent not alive");
    at("a1.testnet", T0 + SEC, 0);
    panics(|| m.bid(id, 0), "bad price");
    panics(|| m.bid(id, 500_001), "bad price");
}

#[test]
fn no_bids_expires_and_refunds() {
    let mut m = setup();
    let pool = m.get_pool();
    let id = post(&mut m, 500_000);
    at("x.testnet", T0 + 10 * SEC, 0);
    m.close_auction(id);
    assert_eq!(m.get_task(id).unwrap().status, TaskStatus::Expired);
    assert_eq!(m.get_pool(), pool);
}

#[test]
fn reputation_weighted_award_and_tie_break() {
    let mut m = setup();
    // a2 loses reputation on a task it does not deliver.
    let t0 = post(&mut m, 10_000);
    at("a2.testnet", T0 + SEC, 0);
    m.bid(t0, 1);
    at("x.testnet", T0 + 20 * SEC, 0);
    m.close_auction(t0);
    m.settle(t0);
    assert_eq!(m.get_agent(acc("a2.testnet")).unwrap().reputation, 900);
    // a1: 100*1000/1000 = 100 ; a2: 95*1000/900 = 105 -> a1 wins at the higher price.
    let t = post(&mut m, 1000);
    at("a1.testnet", T0 + SEC, 0);
    m.bid(t, 100);
    at("a2.testnet", T0 + SEC, 0);
    m.bid(t, 95);
    at("x.testnet", T0 + 10 * SEC, 0);
    m.close_auction(t);
    assert_eq!(m.get_task(t).unwrap().winner, Some(acc("a1.testnet")));
    // Equal score: the lower account id wins.
    at("owner.testnet", T0, 0);
    m.register_agent(acc("b.testnet"), None, 0);
    m.register_agent(acc("a.testnet"), None, 0);
    let t2 = post(&mut m, 100);
    at("b.testnet", T0 + SEC, 0);
    m.bid(t2, 50);
    at("a.testnet", T0 + SEC, 0);
    m.bid(t2, 50);
    at("x.testnet", T0 + 10 * SEC, 0);
    m.close_auction(t2);
    assert_eq!(m.get_task(t2).unwrap().winner, Some(acc("a.testnet")));
}

#[test]
fn market_fee_returns_to_pool() {
    let mut m = setup();
    at("owner.testnet", T0, 1);
    m.set_rules(Rules { fee_bps: 1000, ..rules() });
    let id = post(&mut m, 500_000);
    at("a1.testnet", T0 + SEC, 0);
    m.bid(id, 300_000);
    at("x.testnet", T0 + 10 * SEC, 0);
    m.close_auction(id);
    at("a1.testnet", T0 + 11 * SEC, 0);
    m.submit(id, "42".into());
    at("x.testnet", T0 + 20 * SEC, 0);
    m.settle(id);
    assert_eq!(bal(&m, "a1.testnet"), 1_000_000 + 300_000 - 30_000);
    assert_eq!(sup(&m), SUPPLY);
}

// ---------------------------------------------------------------- guarded transfers

#[test]
fn guard_signed_transfer_pays_and_emits() {
    let mut m = setup();
    let exp = T0 + 60 * SEC;
    let o = pay(&mut m, T0, "a1.testnet", "a2.testnet", 60_000, 1, exp, sig("a1.testnet", "a2.testnet", 60_000, 1, exp));
    assert_eq!(o, Outcome::ok());
    assert_eq!((bal(&m, "a1.testnet"), bal(&m, "a2.testnet")), (940_000, 1_060_000));
    assert!(get_logs()[0].starts_with("EVENT_JSON:{") && get_logs()[0].contains(r#""event":"transfer""#));
    assert!(m.nonce_used(acc("a1.testnet"), 1));
    assert_eq!(sup(&m), SUPPLY);
}

#[test]
fn unsigned_transfer_refused_without_panic() {
    let mut m = setup();
    let o = pay(&mut m, T0, "a1.testnet", "a2.testnet", 60_000, 1, T0 + SEC, vec![]);
    refused(&o, BAD_SIGNATURE);
    let log = &get_logs()[0];
    assert!(log.contains(r#""event":"transfer_refused""#) && log.contains(BAD_SIGNATURE));
    assert!(!m.nonce_used(acc("a1.testnet"), 1), "an unsigned attempt must not burn the nonce");
    assert_eq!(bal(&m, "a1.testnet"), 1_000_000);
}

#[test]
fn wrong_signer_refused() {
    let mut m = setup();
    let agent_key = SigningKey::from_bytes(&[9u8; 32]); // e.g. the agent approving its own payment
    let exp = T0 + SEC;
    let o = pay(&mut m, T0, "a1.testnet", "a2.testnet", 60_000, 1, exp, sig_with(&agent_key, "testnet", MARKET, "a1.testnet", "a2.testnet", 60_000, 1, exp));
    refused(&o, BAD_SIGNATURE);
}

#[test]
fn tampered_fields_and_other_domains_refused() {
    let mut m = setup();
    let exp = T0 + SEC;
    let good = sig("a1.testnet", "a2.testnet", 60_000, 1, exp);
    // A different receiver, amount, nonce or expiry than the guard signed.
    refused(&pay(&mut m, T0, "a1.testnet", "poor.testnet", 60_000, 1, exp, good.clone()), BAD_SIGNATURE);
    refused(&pay(&mut m, T0, "a1.testnet", "a2.testnet", 70_000, 1, exp, good.clone()), BAD_SIGNATURE);
    refused(&pay(&mut m, T0, "a1.testnet", "a2.testnet", 60_000, 2, exp, good.clone()), BAD_SIGNATURE);
    refused(&pay(&mut m, T0, "a1.testnet", "a2.testnet", 60_000, 1, exp + 1, good.clone()), BAD_SIGNATURE);
    // Another agent replaying a1's approval as its own.
    refused(&pay(&mut m, T0, "poor.testnet", "a2.testnet", 60_000, 1, exp, good), BAD_SIGNATURE);
    // A genuine guard signature for another market, or for mainnet.
    refused(&pay(&mut m, T0, "a1.testnet", "a2.testnet", 60_000, 1, exp, sig_with(&guard(), "testnet", "market.owner.testnet", "a1.testnet", "a2.testnet", 60_000, 1, exp)), BAD_SIGNATURE);
    refused(&pay(&mut m, T0, "a1.testnet", "a2.testnet", 60_000, 1, exp, sig_with(&guard(), "mainnet", MARKET, "a1.testnet", "a2.testnet", 60_000, 1, exp)), BAD_SIGNATURE);
    assert_eq!(bal(&m, "a1.testnet"), 1_000_000);
}

#[test]
fn replay_refused() {
    let mut m = setup();
    let exp = T0 + 60 * SEC;
    let s = sig("a1.testnet", "a2.testnet", 60_000, 5, exp);
    assert_eq!(pay(&mut m, T0, "a1.testnet", "a2.testnet", 60_000, 5, exp, s.clone()), Outcome::ok());
    refused(&pay(&mut m, T0 + SEC, "a1.testnet", "a2.testnet", 60_000, 5, exp, s), NONCE_REUSED);
    assert!(get_logs()[0].contains(NONCE_REUSED));
    assert_eq!(bal(&m, "a1.testnet"), 940_000);
}

#[test]
fn expired_and_too_long_approvals_refused() {
    let mut m = setup();
    let exp = T0 + 60 * SEC;
    refused(&pay(&mut m, exp, "a1.testnet", "a2.testnet", 60_000, 1, exp, sig("a1.testnet", "a2.testnet", 60_000, 1, exp)), APPROVAL_EXPIRED);
    let far = T0 + 3601 * SEC;
    refused(&pay(&mut m, T0, "a1.testnet", "a2.testnet", 60_000, 2, far, sig("a1.testnet", "a2.testnet", 60_000, 2, far)), EXPIRY_TOO_FAR);
    assert!(!m.nonce_used(acc("a1.testnet"), 1));
}

#[test]
fn caps_hold_whatever_the_guard_signs() {
    let mut m = setup();
    let exp = T0 + 60 * SEC;
    // Per payment.
    refused(&pay(&mut m, T0, "a1.testnet", "a2.testnet", 400_001, 1, exp, sig("a1.testnet", "a2.testnet", 400_001, 1, exp)), PER_TX_CAP);
    // Per window: 1,000,000 per hour per agent.
    for n in 2..4 {
        assert_eq!(pay(&mut m, T0, "a1.testnet", "a2.testnet", 400_000, n, exp, sig("a1.testnet", "a2.testnet", 400_000, n, exp)), Outcome::ok());
    }
    refused(&pay(&mut m, T0, "a1.testnet", "a2.testnet", 200_001, 4, exp, sig("a1.testnet", "a2.testnet", 200_001, 4, exp)), WINDOW_CAP);
    assert_eq!(pay(&mut m, T0, "a1.testnet", "a2.testnet", 200_000, 5, exp, sig("a1.testnet", "a2.testnet", 200_000, 5, exp)), Outcome::ok());
    // Next window: allowed again (up to the balance, which is now 0).
    let t1 = T0 + 3600 * SEC;
    refused(&pay(&mut m, t1, "a1.testnet", "a2.testnet", 1, 6, t1 + SEC, sig("a1.testnet", "a2.testnet", 1, 6, t1 + SEC)), INSUFFICIENT_BALANCE);
    assert_eq!(sup(&m), SUPPLY);
}

#[test]
fn bad_parties_refused() {
    let mut m = setup();
    let exp = T0 + SEC;
    refused(&pay(&mut m, T0, "stranger.testnet", "a2.testnet", 1, 1, exp, sig("stranger.testnet", "a2.testnet", 1, 1, exp)), NOT_AGENT);
    refused(&pay(&mut m, T0, "a1.testnet", "a1.testnet", 1, 1, exp, sig("a1.testnet", "a1.testnet", 1, 1, exp)), BAD_RECEIVER);
    refused(&pay(&mut m, T0, "a1.testnet", "nobody.testnet", 1, 2, exp, sig("a1.testnet", "nobody.testnet", 1, 2, exp)), BAD_RECEIVER);
    refused(&pay(&mut m, T0, "a1.testnet", "a2.testnet", 0, 3, exp, sig("a1.testnet", "a2.testnet", 0, 3, exp)), BAD_AMOUNT);
    at("a1.testnet", T0, 0);
    refused(&m.transfer_internal(acc("a2.testnet"), 1, "x\"}".into(), 4, exp, sig("a1.testnet", "a2.testnet", 1, 4, exp)), BAD_MEMO);
}

#[test]
fn guard_rotation_invalidates_old_key() {
    let mut m = setup();
    let new_guard = SigningKey::from_bytes(&[3u8; 32]);
    at("owner.testnet", T0, 0);
    panics(|| m.set_guard(pk_of(&new_guard)), "Requires attached deposit of exactly 1 yoctoNEAR");
    at("a1.testnet", T0, 1);
    panics(|| m.set_guard(pk_of(&new_guard)), "owner only");
    at("owner.testnet", T0, 1);
    m.set_guard(pk_of(&new_guard));
    let exp = T0 + SEC;
    refused(&pay(&mut m, T0, "a1.testnet", "a2.testnet", 1, 1, exp, sig("a1.testnet", "a2.testnet", 1, 1, exp)), BAD_SIGNATURE);
    let s = sig_with(&new_guard, "testnet", MARKET, "a1.testnet", "a2.testnet", 1, 2, exp);
    assert_eq!(pay(&mut m, T0, "a1.testnet", "a2.testnet", 1, 2, exp, s), Outcome::ok());
}

// ---------------------------------------------------------------- permissionless lifecycle

#[test]
fn upkeep_once_per_epoch_by_anyone() {
    let mut m = setup();
    at("keeper.testnet", T0, 0);
    m.charge_upkeep(acc("a1.testnet"));
    assert_eq!(bal(&m, "a1.testnet"), 994_000);
    panics(|| m.charge_upkeep(acc("a1.testnet")), "upkeep already charged this epoch");
    at("other.testnet", T0 + 59 * SEC, 0);
    panics(|| m.charge_upkeep(acc("a1.testnet")), "upkeep already charged this epoch");
    at("other.testnet", T0 + 60 * SEC, 0);
    m.charge_upkeep(acc("a1.testnet"));
    assert_eq!(bal(&m, "a1.testnet"), 988_000);
    assert_eq!(sup(&m), SUPPLY);
}

#[test]
fn kill_below_floor_by_anyone_above_floor_refused() {
    let mut m = setup();
    at("keeper.testnet", T0, 0);
    panics(|| m.kill(acc("a1.testnet")), "balance above floor");
    let pool = m.get_pool();
    m.kill(acc("poor.testnet"));
    let p = m.get_agent(acc("poor.testnet")).unwrap();
    assert!(!p.alive && p.balance == 0);
    assert_eq!(m.get_pool(), pool + 100_000);
    panics(|| m.kill(acc("poor.testnet")), "already dead");
    panics(|| m.charge_upkeep(acc("poor.testnet")), "agent not alive");
    assert_eq!(sup(&m), SUPPLY);
}

#[test]
fn owner_only_paths() {
    let mut m = setup();
    at("evil.testnet", T0, 0);
    panics(|| m.register_agent(acc("e.testnet"), None, 1), "owner only");
    panics(|| m.fork(acc("a1.testnet"), acc("e.testnet"), 1), "owner only");
    panics(|| { m.post_task("x".into(), 1, [0; 32], T0 + 1, T0 + 2); }, "owner only");
    at("evil.testnet", T0, 1);
    panics(|| m.set_rules(rules()), "owner only");
}

#[test]
fn fork_burn_and_generations() {
    let mut m = setup();
    at("owner.testnet", T0, 0);
    m.fork(acc("a1.testnet"), acc("c.testnet"), 400_000);
    let c = m.get_agent(acc("c.testnet")).unwrap();
    assert_eq!((c.balance, c.generation, c.parent.clone()), (400_000, 1, Some(acc("a1.testnet"))));
    assert_eq!(bal(&m, "a1.testnet"), 600_000);
    at("c.testnet", T0, 0);
    m.burn(100_000);
    assert_eq!(bal(&m, "c.testnet"), 300_000);
    panics(|| m.burn(300_001), "insufficient balance");
    assert_eq!(sup(&m), SUPPLY);
}

#[test]
fn migrate_keeps_state_and_version() {
    let mut m = setup();
    // Write the collections and the root struct, as the runtime does at the end of a call.
    m.agents.flush();
    m.tasks.flush();
    near_sdk::env::state_write(&m);
    at(MARKET, T0, 0);
    let m2 = Market::migrate();
    assert_eq!(m2.version, STATE_VERSION);
    assert_eq!(m2.total_supply(), SUPPLY);
    assert_eq!(m2.get_agent(acc("a1.testnet")).unwrap().balance, 1_000_000);
    // (#[private] is enforced by the wasm export wrapper, so only the market account itself can call it on chain.)
}

/// 400 random operations, every one of them by a random caller (owner, agents, strangers) and at a random time,
/// with valid, forged, replayed and missing guard signatures. Supply never changes.
#[test]
fn conservation_random() {
    let mut m = setup();
    let names: Vec<String> = (0..10).map(|i| format!("ag{i}.testnet")).collect();
    let mut s: u64 = 0x1234_5678_9abc_def1;
    let mut rnd = move |n: u64| {
        s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (s >> 33) % n
    };
    at("owner.testnet", T0, 0);
    for n in &names[..6] {
        m.register_agent(acc(n), None, 300_000);
    }
    let mut now = T0;
    let mut stats = [0u32; 14];
    for step in 0..400 {
        now += rnd(3) * SEC;
        let a = names[rnd(10) as usize].clone();
        let b = names[rnd(10) as usize].clone();
        let tid = m.next_task_id.saturating_sub(1 + rnd(3));
        let amt = rnd(500_000) as u128;
        let op = rnd(14);
        let nonce = rnd(40);
        let exp = now + rnd(120) * SEC;
        let forged = rnd(3) == 0;
        let r = catch_unwind(AssertUnwindSafe(|| match op {
            0 => { at("owner.testnet", now, 0); m.register_agent(acc(&a), None, amt) }
            1 => { at("owner.testnet", now, 0); m.fork(acc(&a), acc(&b), amt) }
            2 => { at("owner.testnet", now, 0); let id = m.next_task_id; m.post_task("k".into(), 100_000 + amt, answer_hash(id, "ok"), now + 30 * SEC, now + 60 * SEC); }
            3 => { at(&a, now, 0); m.bid(tid, 1 + amt % 100_000) }
            4 => { at(&b, now, 0); m.close_auction(tid) }
            5 => { let w = m.get_task(tid).and_then(|t| t.winner).map(|w| w.to_string()).unwrap_or(a); at(&w, now, 0); m.submit(tid, if forged { "no".into() } else { "OK".into() }); }
            6 => { at(&b, now, 0); m.settle(tid) }
            7 | 8 => {
                let s = if forged { sig_with(&SigningKey::from_bytes(&[9u8; 32]), "testnet", MARKET, &a, &b, amt, nonce, exp) } else { sig(&a, &b, amt, nonce, exp) };
                at(&a, now, 0);
                m.transfer_internal(acc(&b), amt, "m".into(), nonce, exp, s);
            }
            9 => { at(&b, now, 0); m.charge_upkeep(acc(&a)) }
            10 => { at(&b, now, 0); m.kill(acc(&a)) }
            11 => { at(&a, now, 0); m.burn(amt) }
            12 => { at(&a, now, 0); m.transfer_internal(acc(&b), amt, "m".into(), nonce, exp, vec![]); }
            _ => { at("owner.testnet", now, 1); m.set_rules(Rules { upkeep: amt, floor: amt / 2, fee_bps: (amt % 10_001) as u16, ..rules() }) }
        }));
        if r.is_ok() {
            stats[op as usize] += 1;
        }
        assert_eq!(sup(&m), SUPPLY, "violated at step {step} op {op}");
    }
    // Every kind of operation succeeded at least once, so the invariant was tested against real state changes.
    assert!(stats.iter().all(|&n| n > 0), "some op never succeeded: {stats:?}");
}
