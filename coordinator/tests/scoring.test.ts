import { describe, it, expect } from "vitest";
import { PublicKey, Keypair } from "@solana/web3.js";
import { createHash } from "crypto";
import { scoreMiner, scoreAllMiners, MinerPrediction } from "../src/services/scoring.js";
import type { ChallengeMarket, MarketOutcome } from "../src/services/polymarket.js";

// ── Test helpers ──────────────────────────────────────────────────────

function makeMiner(): PublicKey {
  return Keypair.generate().publicKey;
}

function makeMarketId(name: string): Buffer {
  return createHash("sha256").update(name).digest();
}

function makeChallengeMarket(driftId: string): ChallengeMarket {
  return {
    marketId: makeMarketId(driftId),
    sourceMarketId: driftId,
    question: `Question for ${driftId}`,
  };
}

// ── scoreMiner tests ──────────────────────────────────────────────────

describe("scoreMiner", () => {
  const markets = [
    makeChallengeMarket("market-a"),
    makeChallengeMarket("market-b"),
    makeChallengeMarket("market-c"),
  ];

  it("scores all correct predictions with tier 1 (1x)", () => {
    const miner = makeMiner();
    const predictions: MinerPrediction[] = markets.map((m) => ({
      miner,
      marketId: m.marketId,
      prediction: 2, // YES
      tier: 1,
    }));
    const outcomes: MarketOutcome[] = markets.map((m) => ({
      sourceMarketId: m.sourceMarketId,
      outcome: true, // YES won
    }));

    const result = scoreMiner(predictions, outcomes, markets);
    expect(result.miner).toEqual(miner);
    expect(result.correctCount).toBe(3);
    expect(result.credits).toBe(3); // 3 × 1x
    expect(result.totalMarkets).toBe(3);
  });

  it("scores all correct predictions with tier 3 (3x)", () => {
    const miner = makeMiner();
    const predictions: MinerPrediction[] = markets.map((m) => ({
      miner,
      marketId: m.marketId,
      prediction: 1, // NO
      tier: 3,
    }));
    const outcomes: MarketOutcome[] = markets.map((m) => ({
      sourceMarketId: m.sourceMarketId,
      outcome: false, // NO won
    }));

    const result = scoreMiner(predictions, outcomes, markets);
    expect(result.correctCount).toBe(3);
    expect(result.credits).toBe(9); // 3 × 3x
  });

  it("scores zero for all wrong predictions", () => {
    const miner = makeMiner();
    const predictions: MinerPrediction[] = markets.map((m) => ({
      miner,
      marketId: m.marketId,
      prediction: 2, // YES
      tier: 2,
    }));
    const outcomes: MarketOutcome[] = markets.map((m) => ({
      sourceMarketId: m.sourceMarketId,
      outcome: false, // NO won — all wrong
    }));

    const result = scoreMiner(predictions, outcomes, markets);
    expect(result.correctCount).toBe(0);
    expect(result.credits).toBe(0);
    expect(result.totalMarkets).toBe(3);
  });

  it("scores partial correctness", () => {
    const miner = makeMiner();
    const predictions: MinerPrediction[] = [
      { miner, marketId: markets[0].marketId, prediction: 2, tier: 1 }, // YES - correct
      { miner, marketId: markets[1].marketId, prediction: 2, tier: 1 }, // YES - wrong
      { miner, marketId: markets[2].marketId, prediction: 1, tier: 1 }, // NO  - correct
    ];
    const outcomes: MarketOutcome[] = [
      { sourceMarketId: "market-a", outcome: true },
      { sourceMarketId: "market-b", outcome: false },
      { sourceMarketId: "market-c", outcome: false },
    ];

    const result = scoreMiner(predictions, outcomes, markets);
    expect(result.correctCount).toBe(2);
    expect(result.credits).toBe(2); // 2 × 1x
    expect(result.totalMarkets).toBe(3);
  });

  it("excludes voided markets (outcome === null)", () => {
    const miner = makeMiner();
    const predictions: MinerPrediction[] = markets.map((m) => ({
      miner,
      marketId: m.marketId,
      prediction: 2,
      tier: 2,
    }));
    const outcomes: MarketOutcome[] = [
      { sourceMarketId: "market-a", outcome: true },
      { sourceMarketId: "market-b", outcome: null }, // voided
      { sourceMarketId: "market-c", outcome: true },
    ];

    const result = scoreMiner(predictions, outcomes, markets);
    expect(result.correctCount).toBe(2);
    expect(result.credits).toBe(4); // 2 × 2x
    expect(result.totalMarkets).toBe(2); // Only 2 scored (1 voided)
  });

  it("handles empty predictions", () => {
    const result = scoreMiner([], [], markets);
    expect(result.credits).toBe(0);
    expect(result.correctCount).toBe(0);
    expect(result.totalMarkets).toBe(0);
  });

  it("handles predictions for unknown markets gracefully", () => {
    const miner = makeMiner();
    const unknownMarketId = makeMarketId("unknown-market");
    const predictions: MinerPrediction[] = [
      { miner, marketId: unknownMarketId, prediction: 2, tier: 1 },
    ];
    const outcomes: MarketOutcome[] = [
      { sourceMarketId: "market-a", outcome: true },
    ];

    const result = scoreMiner(predictions, outcomes, markets);
    expect(result.correctCount).toBe(0);
    expect(result.totalMarkets).toBe(0);
  });

  it("returns zero credits for tier 0 (unstaked)", () => {
    const miner = makeMiner();
    const predictions: MinerPrediction[] = [
      { miner, marketId: markets[0].marketId, prediction: 2, tier: 0 },
    ];
    const outcomes: MarketOutcome[] = [
      { sourceMarketId: "market-a", outcome: true },
    ];

    const result = scoreMiner(predictions, outcomes, markets);
    expect(result.correctCount).toBe(1);
    expect(result.credits).toBe(0); // tier 0 → 0x multiplier
  });
});

// ── scoreAllMiners tests ──────────────────────────────────────────────

describe("scoreAllMiners", () => {
  const markets = [
    makeChallengeMarket("market-x"),
    makeChallengeMarket("market-y"),
  ];

  it("groups predictions by miner and scores independently", () => {
    const miner1 = makeMiner();
    const miner2 = makeMiner();

    const predictions: MinerPrediction[] = [
      { miner: miner1, marketId: markets[0].marketId, prediction: 2, tier: 1 }, // YES - correct
      { miner: miner1, marketId: markets[1].marketId, prediction: 2, tier: 1 }, // YES - wrong
      { miner: miner2, marketId: markets[0].marketId, prediction: 1, tier: 3 }, // NO  - wrong
      { miner: miner2, marketId: markets[1].marketId, prediction: 1, tier: 3 }, // NO  - correct
    ];
    const outcomes: MarketOutcome[] = [
      { sourceMarketId: "market-x", outcome: true },
      { sourceMarketId: "market-y", outcome: false },
    ];

    const results = scoreAllMiners(predictions, outcomes, markets);

    expect(results.length).toBe(2);

    const score1 = results.find((s) => s.miner.equals(miner1))!;
    expect(score1.correctCount).toBe(1);
    expect(score1.credits).toBe(1); // 1 × 1x

    const score2 = results.find((s) => s.miner.equals(miner2))!;
    expect(score2.correctCount).toBe(1);
    expect(score2.credits).toBe(3); // 1 × 3x
  });

  it("excludes miners with zero credits", () => {
    const miner1 = makeMiner();
    const miner2 = makeMiner();

    const predictions: MinerPrediction[] = [
      { miner: miner1, marketId: markets[0].marketId, prediction: 2, tier: 1 }, // correct
      { miner: miner2, marketId: markets[0].marketId, prediction: 1, tier: 1 }, // wrong
      { miner: miner2, marketId: markets[1].marketId, prediction: 2, tier: 1 }, // wrong
    ];
    const outcomes: MarketOutcome[] = [
      { sourceMarketId: "market-x", outcome: true },
      { sourceMarketId: "market-y", outcome: false },
    ];

    const results = scoreAllMiners(predictions, outcomes, markets);
    expect(results.length).toBe(1);
    expect(results[0].miner.equals(miner1)).toBe(true);
  });

  it("handles empty predictions", () => {
    const results = scoreAllMiners([], [], markets);
    expect(results).toEqual([]);
  });

  it("handles all voided markets", () => {
    const miner = makeMiner();
    const predictions: MinerPrediction[] = [
      { miner, marketId: markets[0].marketId, prediction: 2, tier: 2 },
      { miner, marketId: markets[1].marketId, prediction: 1, tier: 2 },
    ];
    const outcomes: MarketOutcome[] = [
      { sourceMarketId: "market-x", outcome: null },
      { sourceMarketId: "market-y", outcome: null },
    ];

    const results = scoreAllMiners(predictions, outcomes, markets);
    expect(results).toEqual([]); // No credits → excluded
  });
});
