import { PublicKey } from "@solana/web3.js";
import { SolanaService } from "./solana.js";
import { PolymarketService, ChallengeMarket, MarketOutcome } from "./polymarket.js";
import { MinerPrediction, MinerScore, scoreAllMiners } from "./scoring.js";
import { Config, calculateTier } from "../config.js";
import { sendAlert } from "./alerts.js";

// ── Epoch detail store (in-memory, for landing page API) ──────────────

export interface EpochMarketDetail {
  marketId: string;        // hex
  sourceMarketId: string;  // Polymarket conditionId
  question: string;
  outcome: boolean | null; // true=YES, false=NO, null=voided
}

export interface EpochDetail {
  epochId: number;
  markets: EpochMarketDetail[];
  topMiners: Array<{ miner: string; credits: number }>;
  totalPredictions: number;
  correctPredictions: number;
  accuracy: number;        // 0-1
  totalCredits: number;
  funded: boolean;
  rewardAmount: string;
  scoredAt: number;        // unix timestamp
}

// ── Epoch lifecycle manager ────────────────────────────────────────────
//
// Epoch timeline:
//   T=0h  ──── epoch starts, scan Polymarket, build challenge set
//   T=22h ──── commit window closes
//   T=24h ──── epoch ends, advance epoch, reveal window opens
//   T=26h ──── reveal window closes, score miners
//   T=26h+ ─── fund epoch, miners can claim
//
// Zero-market handling: if zero eligible Polymarket markets exist
// at epoch start, auto-skip the epoch.

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [2000, 5000, 10000];

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        console.error(`[epoch] ${label} failed after ${MAX_RETRIES + 1} attempts: ${err}`);
        await sendAlert(`${label} failed after ${MAX_RETRIES + 1} attempts`, String(err));
        throw err;
      }
      const delay = RETRY_DELAYS_MS[attempt] || 10000;
      console.warn(`[epoch] ${label} attempt ${attempt + 1} failed, retrying in ${delay}ms: ${err}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

export class EpochManager {
  private solana: SolanaService;
  private polymarket: PolymarketService;
  private config: Config;

  /** Current epoch's challenge markets (cached at epoch start) */
  private challengeMarkets: ChallengeMarket[] = [];

  /** Resolved outcomes (cached after reveal window) */
  private outcomes: MarketOutcome[] = [];

  /** Epoch detail store for landing page API */
  private epochStore = new Map<number, EpochDetail>();

  constructor(config: Config, solana: SolanaService, polymarket: PolymarketService) {
    this.config = config;
    this.solana = solana;
    this.polymarket = polymarket;
  }

  getChallengeMarkets(): ChallengeMarket[] {
    return this.challengeMarkets;
  }

  getOutcomes(): MarketOutcome[] {
    return this.outcomes;
  }

  getEpochDetail(epochId: number): EpochDetail | undefined {
    return this.epochStore.get(epochId);
  }

  getEpochList(): EpochDetail[] {
    return Array.from(this.epochStore.values()).sort((a, b) => b.epochId - a.epochId);
  }

  /**
   * Called at epoch start. Scans Drift markets and builds the challenge set.
   * If zero markets found, returns empty (coordinator should auto-skip).
   */
  async startEpoch(): Promise<{ marketCount: number; skipped: boolean }> {
    const polymarketMarkets = await this.polymarket.scanMarkets();

    if (polymarketMarkets.length === 0) {
      console.log("[epoch] No eligible Polymarket markets. Epoch will be skipped.");
      this.challengeMarkets = [];
      return { marketCount: 0, skipped: true };
    }

    this.challengeMarkets = this.polymarket.buildChallengeSet(polymarketMarkets);
    this.outcomes = [];

    console.log(
      `[epoch] Challenge set built: ${this.challengeMarkets.length} markets`
    );
    return { marketCount: this.challengeMarkets.length, skipped: false };
  }

  /**
   * Called after reveal window closes. Reads Drift outcomes and scores miners.
   * Reads all revealed commitments from chain, computes credits, submits
   * score_miner TXs, then funds the epoch.
   */
  async closeEpoch(epochId: number): Promise<{
    scores: MinerScore[];
    fundTxSig: string;
  }> {
    // 1. Resolve Polymarket outcomes
    this.outcomes = await this.polymarket.resolveOutcomes(this.challengeMarkets);
    console.log(`[epoch] Resolved ${this.outcomes.length} market outcomes`);

    // 2. Read all revealed commitments from chain
    const predictions = await this.readRevealedPredictions(epochId);
    console.log(`[epoch] Found ${predictions.length} revealed predictions`);

    // 3. Score all miners
    const scores = scoreAllMiners(predictions, this.outcomes, this.challengeMarkets);
    console.log(
      `[epoch] Scored ${scores.length} miners. Total credits: ${scores.reduce(
        (sum, s) => sum + s.credits,
        0
      )}`
    );

    // 4. Submit score_miner TXs on-chain
    for (const score of scores) {
      try {
        const txSig = await this.solana.scoreMiner(epochId, score.miner, score.credits);
        console.log(
          `[epoch] Scored miner ${score.miner.toBase58()}: ${score.credits} credits (tx: ${txSig})`
        );
      } catch (err) {
        console.error(
          `[epoch] Failed to score miner ${score.miner.toBase58()}: ${err}`
        );
      }
    }

    // 5. Fund the epoch (with retry — protocol-critical)
    const fundTxSig = await withRetry(
      `fundEpoch(${epochId})`,
      () => this.solana.fundEpoch(epochId, this.config.epochRewardAmount),
    );
    console.log(`[epoch] Funded epoch ${epochId} (tx: ${fundTxSig})`);

    // 6. Save epoch details to store for landing page API
    const totalPredictions = predictions.length;
    const correctPredictions = scores.reduce((sum, s) => sum + s.correctCount, 0);

    const marketDetails: EpochMarketDetail[] = this.challengeMarkets.map((cm) => {
      const outcome = this.outcomes.find((o) => o.sourceMarketId === cm.sourceMarketId);
      return {
        marketId: cm.marketId.toString("hex"),
        sourceMarketId: cm.sourceMarketId,
        question: cm.question,
        outcome: outcome?.outcome ?? null,
      };
    });

    const topMiners = scores
      .sort((a, b) => b.credits - a.credits)
      .slice(0, 10)
      .map((s) => ({ miner: s.miner.toBase58(), credits: s.credits }));

    this.epochStore.set(epochId, {
      epochId,
      markets: marketDetails,
      topMiners,
      totalPredictions,
      correctPredictions,
      accuracy: totalPredictions > 0 ? correctPredictions / totalPredictions : 0,
      totalCredits: scores.reduce((sum, s) => sum + s.credits, 0),
      funded: true,
      rewardAmount: this.config.epochRewardAmount.toString(),
      scoredAt: Math.floor(Date.now() / 1000),
    });

    return { scores, fundTxSig };
  }

  /**
   * Advance to the next epoch on-chain.
   */
  async advanceEpoch(marketCount: number): Promise<string> {
    return withRetry(
      `advanceEpoch(marketCount=${marketCount})`,
      () => this.solana.advanceEpoch(marketCount),
    );
  }

  /**
   * Read revealed commitments from chain for a given epoch.
   * Uses getProgramAccounts with memcmp filters on Commitment accounts.
   */
  private async readRevealedPredictions(epochId: number): Promise<MinerPrediction[]> {
    const predictions: MinerPrediction[] = [];

    // For each market in the challenge set, check each known miner's commitment
    // In production, use getProgramAccounts with filters for better efficiency.
    // For V1, iterate over known commitments.

    // The Commitment account layout after the 8-byte discriminator:
    // miner: 32 bytes (offset 8)
    // epoch: 8 bytes (offset 40)
    // market_id: 32 bytes (offset 48)
    // hash: 32 bytes (offset 80)
    // revealed: 1 byte (offset 112)
    // prediction: 1 byte (offset 113)
    // bump: 1 byte (offset 114)

    const epochBuf = Buffer.alloc(8);
    epochBuf.writeBigUInt64LE(BigInt(epochId));

    // Get the Commitment account discriminator
    const COMMITMENT_DISCRIMINATOR = Buffer.from(
      "f22b0850c8a2136e", // anchor discriminator for "Commitment"
      "hex"
    );

    try {
      const accounts = await this.solana.connection.getProgramAccounts(
        this.config.programId,
        {
          filters: [
            { dataSize: 115 }, // 8 discriminator + 107 account data
            {
              memcmp: {
                offset: 40, // epoch field
                bytes: epochBuf.toString("base64"),
                encoding: "base64" as any,
              },
            },
            {
              memcmp: {
                offset: 112, // revealed = true (1)
                bytes: Buffer.from([1]).toString("base64"),
                encoding: "base64" as any,
              },
            },
          ],
        }
      );

      for (const { account } of accounts) {
        const data = account.data;
        const miner = new PublicKey(data.subarray(8, 40));
        const marketId = Buffer.from(data.subarray(48, 80));
        const prediction = data[113];

        // Get miner's tier from their MinerState
        const minerState = await this.solana.getMinerState(miner);
        const tier = minerState ? (minerState as any).tier : 0;

        if (prediction === 1 || prediction === 2) {
          predictions.push({ miner, marketId, prediction, tier });
        }
      }
    } catch (err) {
      console.error(`[epoch] Error reading commitments: ${err}`);
    }

    return predictions;
  }
}
