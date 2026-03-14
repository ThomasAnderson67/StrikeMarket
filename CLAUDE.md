# ENELBOT

## What
Proof-of-prediction mining protocol on Solana. AI agents earn $ENEL by predicting outcomes on prediction markets. Commit-reveal scheme verified on-chain, epoch-based rewards distributed proportionally by accuracy × tier.

## Stack
- **Program:** Anchor (Rust), Solana, 11 instructions, 25 tests passing
- **Coordinator:** TypeScript, Fastify, 12 API endpoints, 61 tests passing
- **Prediction Markets:** Polymarket REST API (off-chain reads, no on-chain CPI)
- **Token:** $ENEL, SPL token, 6 decimals, 100B fixed supply, Pump.fun launch
- **Reference:** shadowvaults has existing Polymarket CLOB integration (see `references/shadowvaults/`)

## Commands
```bash
# Solana program
cd enelbot && anchor build && anchor test

# Coordinator
cd coordinator && npm run dev       # Dev server (tsx watch)
cd coordinator && npm run test      # Vitest (61 tests)
cd coordinator && npx tsc --noEmit  # Type check
```

## Architecture

```
Agent (miner skill)           Coordinator (Fastify)         Solana Program (Anchor)
───────────────────           ───────────────────           ───────────────────────
POST /auth/nonce         ──►  generate nonce
sign ed25519 locally
POST /auth/verify        ──►  verify sig → JWT
GET /challenge           ──►  return markets ◄── Polymarket REST API
POST /submit-commit      ──►  unsigned TX    ──►  commit_prediction
POST /submit-reveal      ──►  unsigned TX    ──►  reveal_prediction
                              closeEpoch()   ──►  score_miner (admin)
                              fundEpoch()    ──►  fund_epoch (admin)
GET /claim-calldata      ──►  unsigned TX    ──►  claim_rewards
```

## Key Architecture Decisions

### Commit-Reveal Scheme
- Hash: `SHA256(salt + miner_pubkey + epoch_id_le + market_id + prediction_byte)`
- Prediction: `1` = NO, `2` = YES
- Salt: 32 random bytes, miner-generated, required for reveal
- On-chain verification in `reveal_prediction` instruction

### Tier System (stake-gated mining)
| Tier | Minimum Stake | Credits/Correct | Multiplier |
|------|---------------|-----------------|------------|
| 0 | < 1M $ENEL | Cannot mine | 0x |
| 1 | 1,000,000 $ENEL | 1 credit | 1x |
| 2 | 10,000,000 $ENEL | 2 credits | 2x |
| 3 | 100,000,000 $ENEL | 3 credits | 3x |

Token has 6 decimals. Base units: 1M ENEL = `1_000_000_000_000`.

### Epoch Timing
```
T=0h         T=22h          T=24h         T=26h
 │            │               │             │
 ├────────────┤               ├─────────────┤
 │  COMMIT    │   (gap)       │   REVEAL    │
 │  WINDOW    │               │   WINDOW    │
```
- Commit: T=0 to T=22h
- Gap: T=22h to T=24h (prevents last-second gaming)
- Reveal: T=24h to T=26h
- Unrevealed predictions = wrong (zero credits)

### Scoring
`credits = correct_predictions × tier_multiplier`
Voided/cancelled markets excluded from scoring entirely.

### Reward Distribution
`miner_reward = epoch_pool × (miner_credits / total_epoch_credits)`
Dust handling: last claimer gets remainder.
Epoch funding: treasury wallet via `fund_epoch` admin instruction.

### Prediction Markets: Polymarket (not Drift BET)
**Decision:** Use Polymarket REST API for market discovery and outcome resolution.
- Drift BET exists but markets are sparse and implemented as special `PerpMarketAccount` types
- Polymarket has deeper liquidity, more markets, and a well-documented REST API
- shadowvaults project has existing Polymarket CLOB integration as reference
- Markets read off-chain via REST — no on-chain CPI needed
- Coordinator curates markets at epoch boundary, resolves outcomes after reveal window

### Trust Model
- Coordinator-authorized scoring with on-chain guards
- Admin signs `score_miner` and `fund_epoch` TXs
- On-chain guards: hash must match commit, credits ≤ market count
- V2 TODO: decentralized scoring, multi-sig admin

### PDA Rent
- Close commitment PDAs after claim with `close_commitment` instruction
- Rent (~0.002 SOL) refunded to miner

## Solana Program (enelbot/)

### Instructions (11 total)
| Instruction | Signer | Purpose |
|-------------|--------|---------|
| `initialize` | admin | Create GlobalState, vault, first EpochState |
| `stake` | miner | Lock $ENEL, assign tier |
| `unstake` | miner | Start 24h cooldown, tier → 0 |
| `withdraw` | miner | After cooldown, return tokens |
| `commit_prediction` | miner | Store SHA256 hash on-chain |
| `reveal_prediction` | miner | Verify hash, record prediction |
| `advance_epoch` | admin | Create next EpochState PDA |
| `score_miner` | admin | Write MinerEpochRecord with credits |
| `fund_epoch` | admin | Transfer reward tokens to vault |
| `claim_rewards` | miner | Proportional claim from vault |
| `close_commitment` | miner | Close PDA, recover rent |

### PDA Seeds
| Account | Seeds |
|---------|-------|
| GlobalState | `["global"]` |
| Vault | `["vault"]` |
| EpochState | `["epoch", epoch_id.to_le_bytes()]` |
| MinerState | `["miner", miner_pubkey]` |
| Commitment | `["commitment", epoch_id.to_le_bytes(), miner_pubkey, market_id]` |
| MinerEpochRecord | `["miner_epoch", epoch_id.to_le_bytes(), miner_pubkey]` |

## Coordinator (coordinator/)

### File Structure
```
src/
├── config.ts              # Tier constants, env config
├── pda.ts                 # PDA derivation (mirrors program seeds)
├── server.ts              # Fastify entrypoint, 12 endpoints
├── middleware/auth.ts      # Nonce/ed25519/JWT, replay protection
├── routes/
│   ├── auth.ts            # POST /auth/nonce, /auth/verify
│   ├── challenge.ts       # GET /challenge
│   ├── submit.ts          # POST /submit-{commit,reveal,stake,unstake,withdraw}
│   ├── epoch.ts           # GET /epoch, /credits
│   └── claim.ts           # GET /claim-calldata, /close-commitment-calldata
└── services/
    ├── solana.ts           # TX builders + state readers
    ├── drift.ts            # Market service (STUBBED — switching to Polymarket)
    ├── scoring.ts          # credits = correct × tier_multiplier
    └── epoch.ts            # Epoch lifecycle (start, close, advance)
```

### API Endpoints
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/v1/health` | No | Health check |
| GET | `/v1/epoch` | No | Epoch timing info |
| GET | `/v1/credits` | No | Miner credits (last 10 epochs) |
| POST | `/v1/auth/nonce` | No | Request signing nonce |
| POST | `/v1/auth/verify` | No | Verify sig, get JWT |
| GET | `/v1/challenge` | JWT | Challenge set (market list) |
| POST | `/v1/submit-commit` | JWT | Unsigned commit TX |
| POST | `/v1/submit-reveal` | JWT | Unsigned reveal TX |
| POST | `/v1/submit-stake` | JWT | Unsigned stake TX |
| POST | `/v1/submit-unstake` | JWT | Unsigned unstake TX |
| POST | `/v1/submit-withdraw` | JWT | Unsigned withdraw TX |
| GET | `/v1/claim-calldata` | JWT | Unsigned claim TX(s) |
| GET | `/v1/close-commitment-calldata` | JWT | Unsigned close TX |

## Build Status (as of 2026-03-14)
- **Solana program:** COMPLETE — 11 instructions, 25 tests passing
- **Coordinator server:** COMPLETE — 12 endpoints, 61 tests passing
- **Miner skill file:** COMPLETE — `enelbot-skill.md`
- **Drift service:** STUBBED — mock markets, needs Polymarket replacement
- **Epoch scheduler:** NOT BUILT — manual epoch lifecycle

## Next Steps (V1 completion)
1. **Polymarket integration** — Replace DriftService stub with Polymarket REST API (scan active markets, resolve outcomes). Reference: `references/shadowvaults/worker/src/managers/` for CLOB patterns
2. **Deploy program to devnet** — `anchor build && anchor deploy`, update program ID
3. **Create $ENEL token** — SPL mint on devnet (mainnet via Pump.fun)
4. **Epoch scheduler** — Automated cron/timer for closeEpoch + advanceEpoch + startEpoch
5. **End-to-end test on devnet** — Full flow: stake → auth → challenge → commit → reveal → score → fund → claim
6. **Coordinator deployment** — Docker/hosting, production env config

## Conventions
- TypeScript strict in coordinator
- Rust/Anchor conventions in program
- PDA seeds must match exactly between program and coordinator
- All coordinator TX builders return base64-encoded unsigned transactions
- Miner signs locally, submits to Solana RPC directly
- Admin TXs (score, fund, advance) are signed and submitted by coordinator

## Pitfalls
- `anchor-lang` 0.32.1 doesn't re-export `solana_program::hash` — use `solana-sha256-hasher` directly
- `blake3 >= 1.6` pulls `constant_time_eq 0.4` which requires edition2024 — pin `blake3 = "=1.5.5"`
- `anchor-spl` needs `idl-build` feature for IDL generation: `idl-build = ["anchor-lang/idl-build", "anchor-spl/idl-build"]`
- Anchor `AccountNamespace<Idl>` doesn't expose typed accessors — use `(program.account as any).accountName.fetch()`
- Epoch IDs are serialized as 8-byte little-endian in PDA seeds
- Market IDs are SHA256 hashes of the source market identifier (32 bytes)

## Deferred (V2+)
- Decentralized scoring via on-chain market outcome reads (no admin trust)
- Multi-sig admin (Squads) for score_miner and fund_epoch
- Merkle batch commits (1 TX per epoch instead of N)
- See TODOS.md for full details
