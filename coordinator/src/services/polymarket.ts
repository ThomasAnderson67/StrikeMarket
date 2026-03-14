import { createHash } from "crypto";

// ── Polymarket types ──────────────────────────────────────────────────

/** Raw market from Gamma API */
interface GammaMarket {
  conditionId?: string;
  condition_id?: string;
  id?: string;
  question: string;
  description?: string;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
  clobTokenIds?: string | string[];
  endDate?: string;
  end_date_iso?: string;
  active?: boolean;
  closed?: boolean;
  volume?: number;
  liquidity?: string;
}

export interface PolymarketMarket {
  /** Polymarket condition ID (hex) */
  conditionId: string;
  /** Human-readable question */
  question: string;
  /** Outcomes: ["Yes", "No"] for binary */
  outcomes: string[];
  /** Current prices per outcome (0-1) */
  outcomePrices: number[];
  /** Expected resolution time (unix timestamp) */
  endDate: number;
  /** Trading volume */
  volume: number;
  /** Whether the market is closed/resolved */
  closed: boolean;
}

export interface MarketOutcome {
  /** Source market identifier (Polymarket conditionId) */
  sourceMarketId: string;
  /** Resolved outcome: true = YES won, false = NO won, null = voided */
  outcome: boolean | null;
}

export interface ChallengeMarket {
  /** Deterministic 32-byte market ID for on-chain commitment PDA */
  marketId: Buffer;
  /** Source market identifier (Polymarket conditionId) */
  sourceMarketId: string;
  /** Human-readable question */
  question: string;
}

// ── Polymarket service ────────────────────────────────────────────────
//
// Epoch-boundary polling:
//   T=0h  → scanMarkets() → fetch active binary markets, curate set
//   T=26h → resolveOutcomes() → re-fetch markets, read final prices
//
// Data flow:
//   Gamma API → filter binary + end_date in range → challenge set
//   Gamma API → closed markets → outcomePrices [1,0] or [0,1] → outcome
//
// API:
//   https://gamma-api.polymarket.com/markets — market search
//   https://clob.polymarket.com/markets/{conditionId} — single market

const GAMMA_URL = process.env.POLYMARKET_GAMMA_URL || "https://gamma-api.polymarket.com";
const CLOB_URL = process.env.POLYMARKET_CLOB_URL || "https://clob.polymarket.com";

/** Minimum volume (USD) to include a market */
const MIN_VOLUME = 1000;
/** Maximum markets per epoch */
const MAX_MARKETS_PER_EPOCH = 20;

export class PolymarketService {
  /**
   * Scan active Polymarket markets and filter for epoch eligibility.
   * Called once at epoch start.
   *
   * Filtering criteria:
   * - Binary outcomes only (exactly 2 outcomes)
   * - Market active and not closed
   * - Sufficient volume (> $1000)
   * - End date within a reasonable window
   */
  async scanMarkets(): Promise<PolymarketMarket[]> {
    console.log("[polymarket] Scanning active markets");

    const allMarkets: PolymarketMarket[] = [];
    let offset = 0;
    const limit = 100;

    // Paginate through Gamma API
    while (allMarkets.length < MAX_MARKETS_PER_EPOCH * 3) {
      const markets = await this.fetchGammaMarkets(offset, limit);
      if (markets.length === 0) break;

      for (const m of markets) {
        if (this.isEligible(m)) {
          allMarkets.push(m);
        }
      }

      offset += limit;
      // Stop if we got fewer than requested (last page)
      if (markets.length < limit) break;
    }

    // Sort by volume descending, take top N
    allMarkets.sort((a, b) => b.volume - a.volume);
    const selected = allMarkets.slice(0, MAX_MARKETS_PER_EPOCH);

    console.log(
      `[polymarket] Found ${allMarkets.length} eligible markets, selected top ${selected.length}`
    );
    return selected;
  }

  /**
   * Resolve outcomes for challenge markets by re-fetching from Polymarket.
   * Called after the reveal window closes.
   *
   * Resolution logic:
   * - If market closed and outcomePrices has a "1" → that outcome won
   * - If market not yet resolved → outcome = null (voided for this epoch)
   */
  async resolveOutcomes(markets: ChallengeMarket[]): Promise<MarketOutcome[]> {
    console.log(`[polymarket] Resolving outcomes for ${markets.length} markets`);

    const outcomes: MarketOutcome[] = [];

    for (const market of markets) {
      try {
        const resolved = await this.fetchMarket(market.sourceMarketId);

        if (!resolved) {
          // Market not found — treat as voided
          outcomes.push({ sourceMarketId: market.sourceMarketId, outcome: null });
          continue;
        }

        if (!resolved.closed) {
          // Not yet resolved — voided for this epoch
          outcomes.push({ sourceMarketId: market.sourceMarketId, outcome: null });
          continue;
        }

        // Determine winner from outcomePrices
        // outcomePrices: ["1", "0"] means outcome[0] (usually "Yes") won
        // outcomePrices: ["0", "1"] means outcome[1] (usually "No") won
        const yesIndex = resolved.outcomes.findIndex(
          (o) => o.toLowerCase() === "yes"
        );
        const noIndex = resolved.outcomes.findIndex(
          (o) => o.toLowerCase() === "no"
        );

        if (yesIndex === -1 || noIndex === -1) {
          // Non-standard outcomes — voided
          outcomes.push({ sourceMarketId: market.sourceMarketId, outcome: null });
          continue;
        }

        const yesPrice = resolved.outcomePrices[yesIndex];
        const noPrice = resolved.outcomePrices[noIndex];

        if (yesPrice >= 0.99) {
          outcomes.push({ sourceMarketId: market.sourceMarketId, outcome: true });
        } else if (noPrice >= 0.99) {
          outcomes.push({ sourceMarketId: market.sourceMarketId, outcome: false });
        } else {
          // Market closed but prices not at 0/1 — likely still settling
          outcomes.push({ sourceMarketId: market.sourceMarketId, outcome: null });
        }
      } catch (err) {
        console.error(
          `[polymarket] Error resolving ${market.sourceMarketId}: ${err}`
        );
        outcomes.push({ sourceMarketId: market.sourceMarketId, outcome: null });
      }
    }

    const resolved = outcomes.filter((o) => o.outcome !== null).length;
    console.log(
      `[polymarket] Resolved ${resolved}/${markets.length} markets (${markets.length - resolved} voided)`
    );
    return outcomes;
  }

  /**
   * Build the challenge set from scanned markets.
   * Assigns deterministic 32-byte market IDs via SHA256(conditionId).
   */
  buildChallengeSet(markets: PolymarketMarket[]): ChallengeMarket[] {
    return markets.map((m) => ({
      marketId: createHash("sha256").update(m.conditionId).digest(),
      sourceMarketId: m.conditionId,
      question: m.question,
    }));
  }

  // ── Private helpers ──────────────────────────────────────────────

  private isEligible(market: PolymarketMarket): boolean {
    // Must be binary (exactly 2 outcomes)
    if (market.outcomes.length !== 2) return false;

    // Must have Yes/No outcomes
    const hasYes = market.outcomes.some((o) => o.toLowerCase() === "yes");
    const hasNo = market.outcomes.some((o) => o.toLowerCase() === "no");
    if (!hasYes || !hasNo) return false;

    // Must have sufficient volume
    if (market.volume < MIN_VOLUME) return false;

    // Must have a future end date
    const now = Math.floor(Date.now() / 1000);
    if (market.endDate <= now) return false;

    return true;
  }

  /**
   * Fetch markets from Gamma API with pagination.
   */
  private async fetchGammaMarkets(
    offset: number,
    limit: number
  ): Promise<PolymarketMarket[]> {
    const url = new URL("/markets", GAMMA_URL);
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("order", "volume");
    url.searchParams.set("ascending", "false");

    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      console.error(`[polymarket] Gamma API error: ${res.status}`);
      return [];
    }

    const data = await res.json();
    const raw: GammaMarket[] = Array.isArray(data)
      ? data
      : (data as any).data ?? [];

    return raw.map((m) => this.normalizeGammaMarket(m)).filter(Boolean) as PolymarketMarket[];
  }

  /**
   * Fetch a single market by conditionId (for resolution).
   * Uses Gamma API with conditionId filter.
   */
  private async fetchMarket(conditionId: string): Promise<PolymarketMarket | null> {
    // Try Gamma API first (has resolution data)
    const url = new URL("/markets", GAMMA_URL);
    url.searchParams.set("conditionId", conditionId);
    url.searchParams.set("limit", "1");

    try {
      const res = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
      });

      if (!res.ok) {
        // Fallback to CLOB API
        return this.fetchMarketFromClob(conditionId);
      }

      const data = await res.json();
      const raw: GammaMarket[] = Array.isArray(data) ? data : (data as any).data ?? [];

      if (raw.length === 0) {
        return this.fetchMarketFromClob(conditionId);
      }

      return this.normalizeGammaMarket(raw[0], true);
    } catch {
      return this.fetchMarketFromClob(conditionId);
    }
  }

  /**
   * Fallback: fetch from CLOB API.
   */
  private async fetchMarketFromClob(conditionId: string): Promise<PolymarketMarket | null> {
    try {
      const res = await fetch(`${CLOB_URL}/markets/${conditionId}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return null;

      const m = await res.json();
      return {
        conditionId: m.condition_id || conditionId,
        question: m.question || "",
        outcomes: (m.tokens || []).map((t: any) => t.outcome),
        outcomePrices: (m.tokens || []).map((t: any) => Number(t.price) || 0),
        endDate: m.end_date_iso ? Math.floor(new Date(m.end_date_iso).getTime() / 1000) : 0,
        volume: Number(m.volume) || 0,
        closed: !!m.closed,
      };
    } catch {
      return null;
    }
  }

  /**
   * Normalize a Gamma API market to our PolymarketMarket interface.
   * Gamma returns JSON-encoded strings for outcomes, prices, tokenIds.
   */
  private normalizeGammaMarket(
    m: GammaMarket,
    allowClosed = false
  ): PolymarketMarket | null {
    const conditionId = (m.conditionId || m.condition_id || m.id || "") as string;
    if (!conditionId) return null;

    // Skip closed markets unless explicitly allowed (for resolution)
    if (!allowClosed && m.closed) return null;

    // Parse JSON-encoded arrays
    const outcomes = this.parseJsonArray(m.outcomes) as string[];
    const outcomePrices = (this.parseJsonArray(m.outcomePrices) as string[]).map(Number);

    if (outcomes.length === 0) return null;

    const endDateStr = (m.endDate || m.end_date_iso || "") as string;
    const endDate = endDateStr
      ? Math.floor(new Date(endDateStr).getTime() / 1000)
      : 0;

    return {
      conditionId,
      question: m.question || "",
      outcomes,
      outcomePrices,
      endDate,
      volume: Number(m.volume) || 0,
      closed: !!m.closed,
    };
  }

  private parseJsonArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  }
}
