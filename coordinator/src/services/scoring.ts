import { PublicKey } from "@solana/web3.js";
import { tierMultiplier } from "../config.js";
import type { ChallengeMarket, MarketOutcome } from "./drift.js";

// ── Scoring engine ─────────────────────────────────────────────────────
//
// Scoring formula (from architecture review):
//   credits = correct_predictions × tier_multiplier
//
// Voided markets are excluded from scoring entirely.
// Neither rewarded nor penalized.
//
// Data flow:
//   commitments (on-chain) + outcomes (Drift) → score per miner → credits

export interface MinerPrediction {
  miner: PublicKey;
  marketId: Buffer;
  prediction: number; // 1=NO, 2=YES
  tier: number;
}

export interface MinerScore {
  miner: PublicKey;
  credits: number;
  correctCount: number;
  totalMarkets: number;
}

export function scoreMiner(
  predictions: MinerPrediction[],
  outcomes: MarketOutcome[],
  challengeMarkets: ChallengeMarket[]
): MinerScore {
  if (predictions.length === 0) {
    return {
      miner: PublicKey.default,
      credits: 0,
      correctCount: 0,
      totalMarkets: 0,
    };
  }

  const miner = predictions[0].miner;
  const tier = predictions[0].tier;

  // Build outcome lookup: driftMarketId → outcome
  const outcomeMap = new Map<string, boolean | null>();
  for (const o of outcomes) {
    outcomeMap.set(o.driftMarketId, o.outcome);
  }

  // Build marketId → driftMarketId lookup
  const marketIdToDrift = new Map<string, string>();
  for (const cm of challengeMarkets) {
    marketIdToDrift.set(cm.marketId.toString("hex"), cm.driftMarketId);
  }

  let correctCount = 0;
  let scoredMarkets = 0;

  for (const pred of predictions) {
    const driftId = marketIdToDrift.get(pred.marketId.toString("hex"));
    if (!driftId) continue;

    const outcome = outcomeMap.get(driftId);

    // Voided markets (outcome === null) are excluded from scoring
    if (outcome === null || outcome === undefined) continue;

    scoredMarkets++;

    // prediction: 1=NO, 2=YES. outcome: true=YES, false=NO
    const predictedYes = pred.prediction === 2;
    if (predictedYes === outcome) {
      correctCount++;
    }
  }

  const credits = correctCount * tierMultiplier(tier);

  return {
    miner,
    credits,
    correctCount,
    totalMarkets: scoredMarkets,
  };
}

/**
 * Score all miners for an epoch.
 * Groups predictions by miner, scores each, returns results.
 */
export function scoreAllMiners(
  allPredictions: MinerPrediction[],
  outcomes: MarketOutcome[],
  challengeMarkets: ChallengeMarket[]
): MinerScore[] {
  // Group predictions by miner
  const byMiner = new Map<string, MinerPrediction[]>();
  for (const pred of allPredictions) {
    const key = pred.miner.toBase58();
    const existing = byMiner.get(key) || [];
    existing.push(pred);
    byMiner.set(key, existing);
  }

  const results: MinerScore[] = [];
  for (const predictions of byMiner.values()) {
    const score = scoreMiner(predictions, outcomes, challengeMarkets);
    if (score.credits > 0) {
      results.push(score);
    }
  }

  return results;
}
