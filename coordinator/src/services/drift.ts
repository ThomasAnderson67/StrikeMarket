import { createHash } from "crypto";

// ── Drift BET market types ─────────────────────────────────────────────

export interface DriftMarket {
  /** Drift's on-chain market index or account pubkey */
  driftMarketId: string;
  /** Human-readable question (e.g., "Will BTC exceed $100k by March 31?") */
  question: string;
  /** Expected resolution time (unix timestamp) */
  resolutionTime: number;
  /** Current implied probability (0.0 - 1.0) */
  impliedProbability: number;
}

export interface MarketOutcome {
  driftMarketId: string;
  /** Resolved outcome: true = YES won, false = NO won, null = voided/cancelled */
  outcome: boolean | null;
}

export interface ChallengeMarket {
  /** Deterministic 32-byte market ID for on-chain commitment PDA */
  marketId: Buffer;
  /** Original Drift market reference */
  driftMarketId: string;
  question: string;
}

// ── Drift service ──────────────────────────────────────────────────────
//
// Epoch-boundary polling:
//   T=0h  → scanMarkets() → curate challenge set, cache
//   T=26h → resolveOutcomes() → read final outcomes for scoring
//
// For V1, this is a stub that returns mock markets. Replace with
// Drift SDK integration when connecting to real markets.

export class DriftService {
  /**
   * Scan active Drift BET markets and filter for epoch eligibility.
   * Called once at epoch start.
   *
   * Filtering criteria:
   * - Market must resolve within the epoch window
   * - Market must have sufficient liquidity
   * - Market must be binary (YES/NO)
   */
  async scanMarkets(): Promise<DriftMarket[]> {
    // TODO: Replace with actual Drift SDK integration
    // import { DriftClient, BulkAccountLoader } from "@drift-labs/sdk";
    //
    // Real implementation would:
    // 1. Connect to Drift via SDK
    // 2. List all active BET markets
    // 3. Filter by resolution time, liquidity, binary outcome
    // 4. Return curated subset

    console.log("[drift] Scanning active BET markets (stub)");
    return this.getMockMarkets();
  }

  /**
   * Read resolved outcomes for a set of markets.
   * Called once after the reveal window closes.
   */
  async resolveOutcomes(markets: ChallengeMarket[]): Promise<MarketOutcome[]> {
    // TODO: Replace with actual Drift on-chain state reads
    //
    // Real implementation would:
    // 1. For each market, read the Drift BET account
    // 2. Check if resolved
    // 3. Return outcome (YES/NO/voided)

    console.log(`[drift] Resolving outcomes for ${markets.length} markets (stub)`);
    return markets.map((m) => ({
      driftMarketId: m.driftMarketId,
      // Stub: randomly resolve for development. In production, read from chain.
      outcome: Math.random() > 0.5,
    }));
  }

  /**
   * Build the challenge set for an epoch from raw Drift markets.
   * Assigns deterministic 32-byte market IDs via SHA256(driftMarketId).
   */
  buildChallengeSet(driftMarkets: DriftMarket[]): ChallengeMarket[] {
    return driftMarkets.map((m) => ({
      marketId: createHash("sha256").update(m.driftMarketId).digest(),
      driftMarketId: m.driftMarketId,
      question: m.question,
    }));
  }

  private getMockMarkets(): DriftMarket[] {
    const now = Math.floor(Date.now() / 1000);
    return [
      {
        driftMarketId: "drift-bet-btc-100k",
        question: "Will BTC exceed $100,000 by end of day?",
        resolutionTime: now + 86400,
        impliedProbability: 0.65,
      },
      {
        driftMarketId: "drift-bet-eth-5k",
        question: "Will ETH exceed $5,000 by end of day?",
        resolutionTime: now + 86400,
        impliedProbability: 0.42,
      },
      {
        driftMarketId: "drift-bet-sol-300",
        question: "Will SOL exceed $300 by end of day?",
        resolutionTime: now + 86400,
        impliedProbability: 0.55,
      },
      {
        driftMarketId: "drift-bet-fed-rate",
        question: "Will the Fed announce a rate cut this week?",
        resolutionTime: now + 86400,
        impliedProbability: 0.30,
      },
      {
        driftMarketId: "drift-bet-doge-1",
        question: "Will DOGE reach $1.00 by end of day?",
        resolutionTime: now + 86400,
        impliedProbability: 0.08,
      },
    ];
  }
}
