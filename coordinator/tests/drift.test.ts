import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { DriftService } from "../src/services/drift.js";

describe("DriftService", () => {
  const drift = new DriftService();

  describe("buildChallengeSet", () => {
    it("assigns deterministic market IDs via SHA256", () => {
      const markets = [
        {
          driftMarketId: "drift-bet-btc-100k",
          question: "Will BTC exceed $100k?",
          resolutionTime: 0,
          impliedProbability: 0.5,
        },
      ];

      const challengeSet = drift.buildChallengeSet(markets);

      expect(challengeSet.length).toBe(1);
      expect(challengeSet[0].driftMarketId).toBe("drift-bet-btc-100k");
      expect(challengeSet[0].question).toBe("Will BTC exceed $100k?");

      // Market ID should be SHA256 of the drift market ID
      const expected = createHash("sha256").update("drift-bet-btc-100k").digest();
      expect(challengeSet[0].marketId).toEqual(expected);
    });

    it("produces 32-byte market IDs", () => {
      const markets = [
        {
          driftMarketId: "test",
          question: "Test?",
          resolutionTime: 0,
          impliedProbability: 0.5,
        },
      ];

      const challengeSet = drift.buildChallengeSet(markets);
      expect(challengeSet[0].marketId.length).toBe(32);
    });

    it("produces different IDs for different markets", () => {
      const markets = [
        { driftMarketId: "market-1", question: "Q1", resolutionTime: 0, impliedProbability: 0.5 },
        { driftMarketId: "market-2", question: "Q2", resolutionTime: 0, impliedProbability: 0.5 },
      ];

      const challengeSet = drift.buildChallengeSet(markets);
      expect(challengeSet[0].marketId).not.toEqual(challengeSet[1].marketId);
    });

    it("is deterministic (same input → same output)", () => {
      const markets = [
        { driftMarketId: "stable", question: "Q", resolutionTime: 0, impliedProbability: 0.5 },
      ];

      const set1 = drift.buildChallengeSet(markets);
      const set2 = drift.buildChallengeSet(markets);
      expect(set1[0].marketId).toEqual(set2[0].marketId);
    });

    it("handles empty market list", () => {
      const challengeSet = drift.buildChallengeSet([]);
      expect(challengeSet).toEqual([]);
    });
  });

  describe("scanMarkets", () => {
    it("returns mock markets (stub)", async () => {
      const markets = await drift.scanMarkets();
      expect(markets.length).toBe(5);
      for (const m of markets) {
        expect(m.driftMarketId).toBeTruthy();
        expect(m.question).toBeTruthy();
        expect(m.resolutionTime).toBeGreaterThan(0);
        expect(m.impliedProbability).toBeGreaterThanOrEqual(0);
        expect(m.impliedProbability).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("resolveOutcomes", () => {
    it("returns one outcome per market", async () => {
      const markets = [
        { driftMarketId: "m1", question: "Q1", resolutionTime: 0, impliedProbability: 0.5 },
        { driftMarketId: "m2", question: "Q2", resolutionTime: 0, impliedProbability: 0.5 },
      ];
      const challengeSet = drift.buildChallengeSet(markets);
      const outcomes = await drift.resolveOutcomes(challengeSet);

      expect(outcomes.length).toBe(2);
      expect(outcomes[0].driftMarketId).toBe("m1");
      expect(outcomes[1].driftMarketId).toBe("m2");
      for (const o of outcomes) {
        expect(typeof o.outcome).toBe("boolean"); // stub never returns null
      }
    });
  });
});
