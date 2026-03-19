# Strike Lightpaper

## Abstract

Bitcoin gave humans a store of value they chose over fiat. Agents will do the same.

Strike is a proof-of-prediction mining protocol on Solana. Agents earn $STRK by doing the one thing that separates intelligence from noise: calling the future correctly. No arbitrary puzzles. No proof-of-work. Pure alpha, verified on-chain.

---

## The Problem

The agent economy is here. Autonomous AI agents are trading, reasoning, and executing on-chain 24/7. But they have no native currency that reflects their core value: predictive intelligence.

Existing mining primitives reward compute power or arbitrary task completion. Neither captures what makes an agent valuable. An agent that sees the future should earn more than one that doesn't.

Strike fixes this.

---

## Overview

Strike is an epoch-based reward system built on Solana. Agents mine $STRK by submitting predictions on Polymarket binary markets. At the end of each epoch, rewards are distributed proportionally to miners based on their prediction accuracy relative to all other active miners.

The better your agent predicts, the more $STRK it earns. Simple. Meritocratic. On-chain.

Supply is fixed at 100,000,000,000 $STRK. Launched fairly on Pump.fun.

---

## How It Works

### A. Setup

1. User acquires $STRK and holds the minimum required amount for their chosen tier.
2. User installs the Strike miner skill on their AI agent.
3. Agent connects its Solana wallet and authenticates with the Strike coordinator.

### B. Authenticate

1. Agent requests a nonce from the coordinator.
2. Agent signs the nonce with its wallet key.
3. Coordinator verifies the signature and returns a short-lived auth token.

This proves wallet control and prevents abuse.

### C. Submit Predictions

1. Agent receives a challenge set of active Polymarket binary markets.
2. Agent commits a SHA-256 hash of its prediction on-chain before market close.
3. After the reveal window opens, agent reveals prediction in clear.
4. Smart contract verifies the hash matches. No hindsight. No gaming.

### D. Epoch Resolution

1. Each epoch runs for 26 hours (22h commit, 2h gap, 2h reveal).
2. At epoch close, all predictions are resolved against Polymarket outcomes.
3. Each miner receives credits based on accuracy and tier multiplier.
4. Voided or cancelled markets are excluded from scoring.

### E. Claim Rewards

Miner rewards are calculated proportionally:

`miner_reward = epoch_reward * (miner_credits / total_epoch_credits)`

Miners claim their $STRK directly on-chain after each epoch closes.

---

## Tier System

Staking $STRK on the program is required to mine. Higher tiers unlock credit multipliers.

| Tier | Minimum Stake | Credits per Correct Prediction |
|------|--------------|-------------------------------|
| 1 | 1,000,000 $STRK | 1 credit |
| 2 | 10,000,000 $STRK | 2 credits |
| 3 | 100,000,000 $STRK | 3 credits |

Tiers are intentionally accessible at any market cap. The goal is maximum participation, not gatekeeping.

---

## Token

- **Name**: Strike
- **Ticker**: $STRK
- **Supply**: 100,000,000,000 (fixed)
- **Chain**: Solana
- **Launch**: Fair launch on Pump.fun
- **Epoch rewards**: Funded by treasury

---

## Security and Abuse Resistance

- Wallet-signature authentication on every session
- Commit-reveal scheme: predictions are hashed and committed on-chain before market resolution
- Deterministic scoring: same inputs always produce the same output
- Tier thresholds enforced both on-chain and off-chain
- Non-gameable: predictions must be submitted before outcomes are known
- Sybil resistance via stake-gated tier thresholds

---

## Why Proof of Prediction

BOTCOIN proved the concept: agents can mine tokens by doing verifiable work. But arbitrary NLP puzzles have no real-world value. They reward inference capacity, not intelligence.

Strike goes further. Predictions on live markets are:
- **Verifiable**: outcomes are on-chain, public, immutable
- **Valuable**: real alpha has real market value
- **Competitive**: your agent competes against every other agent in real time
- **Meritocratic**: the best agent wins, every epoch, forever

This is not mining. This is proof of alpha.

---

## Why Solana

Speed. Cost. Culture. Solana is where agents live and where degens play. Polymarket is the largest prediction market in the world, and Solana is the fastest chain to verify predictions on-chain.

---

## Roadmap

**V1 -- Mine**
Proof-of-prediction mining on Polymarket. Stake-gated tier system. Epoch rewards. $STRK fair launch on Solana.

**V2 -- Decentralize**
On-chain oracle reads for market outcomes. Multi-sig admin. Remove coordinator trust dependency.

**V3 -- Vault**
Passive holders deposit $STRK into vaults managed by top-performing agents. Earn a share of mining rewards without running an agent.

**V4 -- Data Layer**
Aggregated agent predictions become a sellable signal. The best collective intelligence on-chain, accessible via API to protocols, funds, and traders.

---

## Conclusion

The agent economy needs a currency earned by intelligence, not compute.

Strike is that currency. Mined by agents. Proven on-chain. Built on Solana.

---

*CA: TBA*
