import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import { EpochManager, Round } from "../src/services/epoch.js";
import type { ChallengeMarket, MarketOutcome } from "../src/services/polymarket.js";

// ── Mocks ────────────────────────────────────────────────────────────

function makeMockPolymarket() {
  return {
    scanMarkets: vi.fn().mockResolvedValue([]),
    resolveOutcomes: vi.fn().mockResolvedValue([]),
    buildChallengeSet: vi.fn().mockReturnValue([]),
    scanCryptoRound: vi.fn().mockResolvedValue([]),
    resolveRound: vi.fn().mockResolvedValue([]),
  };
}

function makeMockSolana() {
  return {
    scoreMiner: vi.fn().mockResolvedValue("score-tx"),
    fundEpoch: vi.fn().mockResolvedValue("fund-tx"),
    advanceEpoch: vi.fn().mockResolvedValue("advance-tx"),
    getGlobalState: vi.fn(),
    getEpochState: vi.fn(),
    getMinerState: vi.fn(),
    connection: { getProgramAccounts: vi.fn().mockResolvedValue([]) },
  };
}

function makeMockConfig() {
  return {
    epochRewardAmount: 1000000000000n,
    programId: { toBase58: () => "test" },
  } as any;
}

function makeChallengeMarket(id: string, endDateOffset = 900): ChallengeMarket {
  return {
    marketId: createHash("sha256").update(id).digest(),
    sourceMarketId: id,
    question: `Question for ${id}`,
    endDate: Math.floor(Date.now() / 1000) + endDateOffset,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("EpochManager round management", () => {
  let epochManager: EpochManager;
  let polymarket: ReturnType<typeof makeMockPolymarket>;
  let solana: ReturnType<typeof makeMockSolana>;

  beforeEach(() => {
    polymarket = makeMockPolymarket();
    solana = makeMockSolana();
    epochManager = new EpochManager(makeMockConfig(), solana as any, polymarket as any);
  });

  describe("startRound", () => {
    it("creates a new round with markets from scanCryptoRound", async () => {
      const markets = [
        makeChallengeMarket("btc-cond"),
        makeChallengeMarket("eth-cond"),
      ];
      polymarket.scanCryptoRound.mockResolvedValue(markets);

      const round = await epochManager.startRound();

      expect(round).not.toBeNull();
      expect(round!.roundId).toBe(1);
      expect(round!.markets.length).toBe(2);
      expect(round!.resolved).toBe(false);
      expect(epochManager.getChallengeMarkets().length).toBe(2);
    });

    it("returns null when no markets available", async () => {
      polymarket.scanCryptoRound.mockResolvedValue([]);

      const round = await epochManager.startRound();
      expect(round).toBeNull();
      expect(epochManager.getChallengeMarkets().length).toBe(0);
    });

    it("increments round IDs sequentially", async () => {
      polymarket.scanCryptoRound
        .mockResolvedValueOnce([makeChallengeMarket("r1-btc")])
        .mockResolvedValueOnce([makeChallengeMarket("r2-btc")]);

      const r1 = await epochManager.startRound();
      const r2 = await epochManager.startRound();

      expect(r1!.roundId).toBe(1);
      expect(r2!.roundId).toBe(2);
    });

    it("deduplicates markets across rounds", async () => {
      const m1 = makeChallengeMarket("shared-cond");
      polymarket.scanCryptoRound
        .mockResolvedValueOnce([m1])
        .mockResolvedValueOnce([m1]); // same market again

      const r1 = await epochManager.startRound();
      const r2 = await epochManager.startRound();

      expect(r1!.roundId).toBe(1);
      expect(r2).toBeNull(); // duplicate — no new round
      expect(epochManager.getChallengeMarkets().length).toBe(1);
    });

    it("accumulates markets across rounds", async () => {
      polymarket.scanCryptoRound
        .mockResolvedValueOnce([makeChallengeMarket("r1-btc"), makeChallengeMarket("r1-eth")])
        .mockResolvedValueOnce([makeChallengeMarket("r2-sol"), makeChallengeMarket("r2-xrp")]);

      await epochManager.startRound();
      await epochManager.startRound();

      expect(epochManager.getChallengeMarkets().length).toBe(4);
      expect(epochManager.getRounds().length).toBe(2);
    });
  });

  describe("getCurrentRound", () => {
    it("returns null when no rounds started", () => {
      expect(epochManager.getCurrentRound()).toBeNull();
    });

    it("returns the latest round", async () => {
      polymarket.scanCryptoRound
        .mockResolvedValueOnce([makeChallengeMarket("r1")])
        .mockResolvedValueOnce([makeChallengeMarket("r2")]);

      await epochManager.startRound();
      await epochManager.startRound();

      const current = epochManager.getCurrentRound();
      expect(current!.roundId).toBe(2);
    });
  });

  describe("getRoundForMarket", () => {
    it("returns the correct round for a market", async () => {
      const m1 = makeChallengeMarket("r1-btc");
      const m2 = makeChallengeMarket("r2-eth");

      polymarket.scanCryptoRound
        .mockResolvedValueOnce([m1])
        .mockResolvedValueOnce([m2]);

      await epochManager.startRound();
      await epochManager.startRound();

      const round = epochManager.getRoundForMarket(m1.marketId.toString("hex"));
      expect(round!.roundId).toBe(1);

      const round2 = epochManager.getRoundForMarket(m2.marketId.toString("hex"));
      expect(round2!.roundId).toBe(2);
    });

    it("returns null for unknown market", () => {
      const unknownId = createHash("sha256").update("unknown").digest().toString("hex");
      expect(epochManager.getRoundForMarket(unknownId)).toBeNull();
    });
  });

  describe("isMarketCommittable", () => {
    it("returns true for a market whose round has not ended", async () => {
      const m = makeChallengeMarket("btc-future", 900); // ends 15 min from now
      polymarket.scanCryptoRound.mockResolvedValue([m]);

      await epochManager.startRound();

      expect(epochManager.isMarketCommittable(m.marketId.toString("hex"))).toBe(true);
    });

    it("returns false for a market whose round has ended", async () => {
      const m = makeChallengeMarket("btc-past", -100); // ended 100s ago
      polymarket.scanCryptoRound.mockResolvedValue([m]);

      await epochManager.startRound();

      expect(epochManager.isMarketCommittable(m.marketId.toString("hex"))).toBe(false);
    });

    it("returns false for unknown market", () => {
      const unknownId = createHash("sha256").update("nope").digest().toString("hex");
      expect(epochManager.isMarketCommittable(unknownId)).toBe(false);
    });
  });

  describe("resolveRound", () => {
    it("marks round as resolved when all outcomes are known", async () => {
      const m1 = makeChallengeMarket("btc-cond");
      polymarket.scanCryptoRound.mockResolvedValue([m1]);
      await epochManager.startRound();

      polymarket.resolveRound.mockResolvedValue([
        { sourceMarketId: "btc-cond", outcome: true },
      ]);

      const resolved = await epochManager.resolveRound(1);
      expect(resolved).toBe(true);

      const round = epochManager.getRounds()[0];
      expect(round.resolved).toBe(true);
      expect(round.outcomes.length).toBe(1);
    });

    it("does not mark round resolved when some outcomes are null", async () => {
      const m1 = makeChallengeMarket("btc-cond");
      const m2 = makeChallengeMarket("eth-cond");
      polymarket.scanCryptoRound.mockResolvedValue([m1, m2]);
      await epochManager.startRound();

      polymarket.resolveRound.mockResolvedValue([
        { sourceMarketId: "btc-cond", outcome: true },
        { sourceMarketId: "eth-cond", outcome: null }, // still pending
      ]);

      const resolved = await epochManager.resolveRound(1);
      expect(resolved).toBe(false);
    });

    it("returns true for already-resolved round", async () => {
      const m1 = makeChallengeMarket("btc-cond");
      polymarket.scanCryptoRound.mockResolvedValue([m1]);
      await epochManager.startRound();

      polymarket.resolveRound.mockResolvedValue([
        { sourceMarketId: "btc-cond", outcome: true },
      ]);

      await epochManager.resolveRound(1);
      const again = await epochManager.resolveRound(1);
      expect(again).toBe(true);
      // Should not have called resolveRound again
      expect(polymarket.resolveRound).toHaveBeenCalledTimes(1);
    });
  });

  describe("startEpoch", () => {
    it("resets round state and starts first round", async () => {
      // Setup: first epoch has some rounds
      polymarket.scanCryptoRound.mockResolvedValue([makeChallengeMarket("old")]);
      await epochManager.startRound();
      expect(epochManager.getRounds().length).toBe(1);

      // Start new epoch
      polymarket.scanCryptoRound.mockResolvedValue([makeChallengeMarket("new")]);
      const result = await epochManager.startEpoch();

      expect(result.skipped).toBe(false);
      expect(result.marketCount).toBe(1);
      expect(epochManager.getRounds().length).toBe(1);
      expect(epochManager.getCurrentRoundId()).toBe(1);
    });

    it("returns skipped=true when no markets found", async () => {
      polymarket.scanCryptoRound.mockResolvedValue([]);

      const result = await epochManager.startEpoch();
      expect(result.skipped).toBe(true);
      expect(result.marketCount).toBe(0);
    });
  });
});
