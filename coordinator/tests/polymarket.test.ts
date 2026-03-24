import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import { PolymarketService, CRYPTO_15M_SERIES } from "../src/services/polymarket.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeGammaMarket(overrides: Record<string, unknown> = {}) {
  return {
    conditionId: "0xabc123",
    question: "Will BTC exceed $100k?",
    outcomes: JSON.stringify(["Yes", "No"]),
    outcomePrices: JSON.stringify(["0.65", "0.35"]),
    clobTokenIds: JSON.stringify(["token1", "token2"]),
    endDate: new Date(Date.now() + 86400_000).toISOString(),
    active: true,
    closed: false,
    volume: 5000,
    liquidity: "10000",
    ...overrides,
  };
}

describe("PolymarketService", () => {
  let service: PolymarketService;

  beforeEach(() => {
    service = new PolymarketService();
    mockFetch.mockReset();
  });

  describe("buildChallengeSet", () => {
    it("assigns deterministic market IDs via SHA256(conditionId)", () => {
      const markets = [
        {
          conditionId: "0xabc123",
          question: "Will BTC exceed $100k?",
          outcomes: ["Yes", "No"],
          outcomePrices: [0.65, 0.35],
          endDate: 0,
          volume: 5000,
        },
      ];

      const set = service.buildChallengeSet(markets);

      expect(set.length).toBe(1);
      expect(set[0].sourceMarketId).toBe("0xabc123");
      expect(set[0].question).toBe("Will BTC exceed $100k?");

      const expected = createHash("sha256").update("0xabc123").digest();
      expect(set[0].marketId).toEqual(expected);
    });

    it("produces 32-byte market IDs", () => {
      const markets = [
        {
          conditionId: "test",
          question: "Q?",
          outcomes: ["Yes", "No"],
          outcomePrices: [0.5, 0.5],
          endDate: 0,
          volume: 0,
        },
      ];

      const set = service.buildChallengeSet(markets);
      expect(set[0].marketId.length).toBe(32);
    });

    it("produces different IDs for different markets", () => {
      const markets = [
        { conditionId: "market-1", question: "Q1", outcomes: ["Yes", "No"], outcomePrices: [0.5, 0.5], endDate: 0, volume: 0 },
        { conditionId: "market-2", question: "Q2", outcomes: ["Yes", "No"], outcomePrices: [0.5, 0.5], endDate: 0, volume: 0 },
      ];

      const set = service.buildChallengeSet(markets);
      expect(set[0].marketId).not.toEqual(set[1].marketId);
    });

    it("is deterministic (same input → same output)", () => {
      const markets = [
        { conditionId: "stable", question: "Q", outcomes: ["Yes", "No"], outcomePrices: [0.5, 0.5], endDate: 0, volume: 0 },
      ];

      const set1 = service.buildChallengeSet(markets);
      const set2 = service.buildChallengeSet(markets);
      expect(set1[0].marketId).toEqual(set2[0].marketId);
    });

    it("handles empty market list", () => {
      expect(service.buildChallengeSet([])).toEqual([]);
    });
  });

  describe("scanMarkets", () => {
    it("fetches from Gamma API and filters binary Yes/No markets", async () => {
      const gammaResponse = [
        makeGammaMarket({ conditionId: "0x1", volume: 5000 }),
        makeGammaMarket({ conditionId: "0x2", volume: 3000 }),
        // Non-binary market (Over/Under) — should be filtered out
        makeGammaMarket({
          conditionId: "0x3",
          outcomes: JSON.stringify(["Over", "Under"]),
          volume: 8000,
        }),
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(gammaResponse),
      });
      // Second page returns empty → stop
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const markets = await service.scanMarkets();

      // Only Yes/No markets included
      expect(markets.length).toBe(2);
      expect(markets[0].conditionId).toBe("0x1");
      expect(markets[1].conditionId).toBe("0x2");
    });

    it("filters out low-volume markets", async () => {
      const gammaResponse = [
        makeGammaMarket({ conditionId: "0x1", volume: 5000 }), // eligible
        makeGammaMarket({ conditionId: "0x2", volume: 500 }),  // too low
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(gammaResponse),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const markets = await service.scanMarkets();
      expect(markets.length).toBe(1);
      expect(markets[0].conditionId).toBe("0x1");
    });

    it("filters out markets with past end dates", async () => {
      const gammaResponse = [
        makeGammaMarket({ conditionId: "0x1" }), // future endDate (default)
        makeGammaMarket({
          conditionId: "0x2",
          endDate: new Date(Date.now() - 86400_000).toISOString(), // past
        }),
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(gammaResponse),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const markets = await service.scanMarkets();
      expect(markets.length).toBe(1);
    });

    it("returns empty array on API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const markets = await service.scanMarkets();
      expect(markets).toEqual([]);
    });

    it("sorts by volume descending", async () => {
      const gammaResponse = [
        makeGammaMarket({ conditionId: "0x-low", volume: 1500 }),
        makeGammaMarket({ conditionId: "0x-high", volume: 50000 }),
        makeGammaMarket({ conditionId: "0x-mid", volume: 10000 }),
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(gammaResponse),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const markets = await service.scanMarkets();
      expect(markets[0].conditionId).toBe("0x-high");
      expect(markets[1].conditionId).toBe("0x-mid");
      expect(markets[2].conditionId).toBe("0x-low");
    });
  });

  describe("resolveOutcomes", () => {
    it("resolves YES winner when outcomePrices is [1, 0]", async () => {
      const challengeMarket = {
        marketId: createHash("sha256").update("0xresolved").digest(),
        sourceMarketId: "0xresolved",
        question: "Did it happen?",
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            makeGammaMarket({
              conditionId: "0xresolved",
              closed: true,
              outcomePrices: JSON.stringify(["1", "0"]),
            }),
          ]),
      });

      const outcomes = await service.resolveOutcomes([challengeMarket]);
      expect(outcomes.length).toBe(1);
      expect(outcomes[0].sourceMarketId).toBe("0xresolved");
      expect(outcomes[0].outcome).toBe(true); // YES won
    });

    it("resolves NO winner when outcomePrices is [0, 1]", async () => {
      const challengeMarket = {
        marketId: createHash("sha256").update("0xno-win").digest(),
        sourceMarketId: "0xno-win",
        question: "Did it happen?",
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            makeGammaMarket({
              conditionId: "0xno-win",
              closed: true,
              outcomes: JSON.stringify(["Yes", "No"]),
              outcomePrices: JSON.stringify(["0", "1"]),
            }),
          ]),
      });

      const outcomes = await service.resolveOutcomes([challengeMarket]);
      expect(outcomes[0].outcome).toBe(false); // NO won
    });

    it("returns null outcome for unresolved market", async () => {
      const challengeMarket = {
        marketId: createHash("sha256").update("0xopen").digest(),
        sourceMarketId: "0xopen",
        question: "Still open?",
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            makeGammaMarket({
              conditionId: "0xopen",
              closed: false,
              outcomePrices: JSON.stringify(["0.6", "0.4"]),
            }),
          ]),
      });

      const outcomes = await service.resolveOutcomes([challengeMarket]);
      expect(outcomes[0].outcome).toBeNull();
    });

    it("returns null outcome when market not found", async () => {
      const challengeMarket = {
        marketId: createHash("sha256").update("0xghost").digest(),
        sourceMarketId: "0xghost",
        question: "Missing?",
      };

      // Gamma returns empty
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });
      // CLOB fallback also fails
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      const outcomes = await service.resolveOutcomes([challengeMarket]);
      expect(outcomes[0].outcome).toBeNull();
    });

    it("returns null for non-binary outcomes (Over/Under)", async () => {
      const challengeMarket = {
        marketId: createHash("sha256").update("0xnonbinary").digest(),
        sourceMarketId: "0xnonbinary",
        question: "Over/Under?",
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            makeGammaMarket({
              conditionId: "0xnonbinary",
              closed: true,
              outcomes: JSON.stringify(["Over", "Under"]),
              outcomePrices: JSON.stringify(["1", "0"]),
            }),
          ]),
      });

      const outcomes = await service.resolveOutcomes([challengeMarket]);
      expect(outcomes[0].outcome).toBeNull(); // Non-standard → voided
    });

    it("handles API errors gracefully", async () => {
      const challengeMarket = {
        marketId: createHash("sha256").update("0xerr").digest(),
        sourceMarketId: "0xerr",
        question: "Error?",
      };

      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const outcomes = await service.resolveOutcomes([challengeMarket]);
      expect(outcomes[0].outcome).toBeNull();
    });
  });

  describe("CRYPTO_15M_SERIES", () => {
    it("has 7 series slugs", () => {
      expect(CRYPTO_15M_SERIES.length).toBe(7);
    });

    it("contains expected tokens", () => {
      expect(CRYPTO_15M_SERIES).toContain("btc-up-or-down-15m");
      expect(CRYPTO_15M_SERIES).toContain("eth-up-or-down-15m");
      expect(CRYPTO_15M_SERIES).toContain("sol-up-or-down-15m");
    });
  });

  describe("scanCryptoRound", () => {
    function makeEventResponse(token: string, overrides: Record<string, unknown> = {}) {
      const endDate = new Date(Date.now() + 900_000).toISOString();
      return [{
        id: `event-${token}`,
        title: `${token.toUpperCase()} Up or Down - 15m`,
        ticker: `${token}-updown-15m-12345`,
        active: true,
        closed: false,
        endDate,
        markets: [
          {
            conditionId: `cond-${token}`,
            outcomes: JSON.stringify(["Up", "Down"]),
            outcomePrices: JSON.stringify(["0.5", "0.5"]),
            closed: false,
            active: true,
            endDate,
            question: `${token.toUpperCase()} Up or Down - 15m`,
          },
        ],
        ...overrides,
      }];
    }

    const TOKENS = ["btc", "eth", "sol", "xrp", "doge", "hype", "bnb"];

    it("fetches markets from all 7 series", async () => {
      // Each token makes 1 fetch call to /events?slug={token}-updown-15m-{ts}
      for (const token of TOKENS) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeEventResponse(token)),
        });
      }

      const markets = await service.scanCryptoRound();

      expect(markets.length).toBe(7);
      expect(markets[0].sourceMarketId).toBe("cond-btc");
    });

    it("skips series with no active events", async () => {
      // First token has active event
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeEventResponse("btc")),
      });

      // Rest return empty (current round) then empty (next round fallback)
      for (let i = 1; i < TOKENS.length; i++) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([]),
        });
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([]),
        });
      }

      const markets = await service.scanCryptoRound();
      expect(markets.length).toBe(1);
    });

    it("skips series with API errors", async () => {
      // First succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeEventResponse("btc")),
      });

      // Rest fail
      for (let i = 1; i < TOKENS.length; i++) {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      }

      const markets = await service.scanCryptoRound();
      expect(markets.length).toBe(1);
    });

    it("returns empty array when all series fail", async () => {
      for (const _token of TOKENS) {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      }

      const markets = await service.scanCryptoRound();
      expect(markets).toEqual([]);
    });

    it("assigns deterministic 32-byte market IDs", async () => {
      for (const token of TOKENS) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeEventResponse(token)),
        });
      }

      const markets = await service.scanCryptoRound();

      for (const m of markets) {
        expect(m.marketId.length).toBe(32);
        const expected = createHash("sha256").update(m.sourceMarketId).digest();
        expect(m.marketId).toEqual(expected);
      }
    });

    it("includes endDate on returned markets", async () => {
      for (const slug of CRYPTO_15M_SERIES) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(makeSeriesResponse(slug)),
        });
      }

      const markets = await service.scanCryptoRound();
      for (const m of markets) {
        expect(m.endDate).toBeDefined();
        expect(m.endDate).toBeGreaterThan(Math.floor(Date.now() / 1000));
      }
    });

    it("falls back to next round when current round not found", async () => {
      const endDate = new Date(Date.now() + 900_000).toISOString();

      // BTC: current round empty, next round found
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]), // current round not found
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeEventResponse("btc")), // next round found
      });

      // Other series: current round empty, next round empty
      for (let i = 1; i < TOKENS.length; i++) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([]),
        });
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([]),
        });
      }

      const markets = await service.scanCryptoRound();
      expect(markets.length).toBe(1);
      expect(markets[0].sourceMarketId).toBe("cond-btc");
    });
  });

  describe("resolveRound", () => {
    it("resolves Up winner as outcome=true", async () => {
      const market = {
        marketId: createHash("sha256").update("cond-up").digest(),
        sourceMarketId: "cond-up",
        question: "BTC Up or Down?",
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([
          makeGammaMarket({
            conditionId: "cond-up",
            closed: true,
            outcomes: JSON.stringify(["Up", "Down"]),
            outcomePrices: JSON.stringify(["1", "0"]),
          }),
        ]),
      });

      const outcomes = await service.resolveRound([market]);
      expect(outcomes.length).toBe(1);
      expect(outcomes[0].outcome).toBe(true); // Up = YES = true
    });

    it("resolves Down winner as outcome=false", async () => {
      const market = {
        marketId: createHash("sha256").update("cond-down").digest(),
        sourceMarketId: "cond-down",
        question: "ETH Up or Down?",
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([
          makeGammaMarket({
            conditionId: "cond-down",
            closed: true,
            outcomes: JSON.stringify(["Up", "Down"]),
            outcomePrices: JSON.stringify(["0", "1"]),
          }),
        ]),
      });

      const outcomes = await service.resolveRound([market]);
      expect(outcomes[0].outcome).toBe(false); // Down = NO = false
    });

    it("returns null for unresolved round markets", async () => {
      const market = {
        marketId: createHash("sha256").update("cond-open").digest(),
        sourceMarketId: "cond-open",
        question: "SOL Up or Down?",
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([
          makeGammaMarket({
            conditionId: "cond-open",
            closed: false,
            outcomes: JSON.stringify(["Up", "Down"]),
            outcomePrices: JSON.stringify(["0.6", "0.4"]),
          }),
        ]),
      });

      const outcomes = await service.resolveRound([market]);
      expect(outcomes[0].outcome).toBeNull();
    });

    it("handles mixed Up/Down and Yes/No outcomes", async () => {
      const market = {
        marketId: createHash("sha256").update("cond-yesno").digest(),
        sourceMarketId: "cond-yesno",
        question: "Fallback Yes/No?",
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([
          makeGammaMarket({
            conditionId: "cond-yesno",
            closed: true,
            outcomes: JSON.stringify(["Yes", "No"]),
            outcomePrices: JSON.stringify(["1", "0"]),
          }),
        ]),
      });

      const outcomes = await service.resolveRound([market]);
      expect(outcomes[0].outcome).toBe(true); // Yes won → true
    });
  });
});
