# Strike TODOs

## Deferred Work

### 1. Decentralized Scoring (V2)
**What:** Replace coordinator-admin scoring with on-chain Polymarket oracle CPI — program reads market outcomes directly and computes credits without coordinator involvement.
**Why:** V1 coordinator is a trusted scoring authority, which conflicts with the lightpaper's trustlessness promise. Decentralizing scoring removes the single point of trust for the most critical operation (reward distribution).
**Pros:** Fully trustless scoring, no admin key risk for credits, stronger narrative alignment.
**Cons:** Polymarket oracle CPI integration is complex (account structure, cross-program invocation), increases program size, ties program to Polymarket's specific on-chain layout.
**Context:** V1 uses coordinator-authorized scoring with on-chain guards (hash must match commit, credits <= market count). The trust boundary is documented in the architecture review. Decentralization is the natural V2 step.
**Depends on:** V1 launch, stable Polymarket account structure, understanding of Polymarket oracle CPI patterns.

### 2. Multi-sig Admin
**What:** Replace single coordinator admin key with a Squads multi-sig for `fund_epoch()` and `score_miner()` calls.
**Why:** Single admin key is a security liability as TVL grows. If the key is compromised, an attacker could fabricate scores or drain the treasury.
**Pros:** Reduces single-key risk, industry-standard practice for protocol admin operations.
**Cons:** Adds operational overhead — every epoch requires multi-sig approval. Squads SDK dependency.
**Context:** The program just checks `signer == admin`. Changing from EOA to multi-sig is a config change (update admin pubkey to the Squads vault). Low implementation effort.
**Depends on:** V1 launch. Can be done independently of other TODOs.

### 3. Merkle Batch Commits
**What:** Allow miners to batch all predictions into a single Merkle root commit (1 TX per epoch) instead of N individual commit TXs per market.
**Why:** Reduces transaction count for active miners. A miner predicting on 10 markets currently needs 10 commit TXs + 10 reveal TXs. Merkle batching reduces commits to 1 TX + N reveal TXs with Merkle proofs.
**Pros:** Lower gas costs for miners, fewer transactions to manage in the skill.
**Cons:** Adds Merkle proof verification to the on-chain program (more compute units, more complexity). Skill must construct Merkle trees. Testing surface increases significantly.
**Context:** Solana TX costs are already low (~0.000005 SOL each), so this is an optimization, not a necessity. Prioritize after V1 proves the core loop works. Consider when prediction volume per miner exceeds ~20 markets/epoch.
**Depends on:** V1 launch, understanding of real-world prediction volumes.

## Build in V1 (from review)

### 4. Nonce Replay Protection
**What:** Track used auth nonces in coordinator to prevent replay attacks.
**Why:** Auth nonce replay is a real attack vector — without tracking, a signed nonce could be reused to obtain multiple auth tokens.
**Implementation:** Store used nonces in a Set/DB with TTL matching token expiry. Check on `/v1/auth/verify` before issuing token.

### 5. Zero-Market Epoch Handling
**What:** Handle edge case where zero eligible Polymarket markets exist at epoch start.
**Why:** Polymarket could have downtime or all markets could be illiquid. Without handling, coordinator returns empty challenge set and miners get confused.
**Implementation:** If zero eligible markets at epoch start, coordinator skips the epoch (auto-advance) and returns a clear status message to miners via `/v1/challenge`.
