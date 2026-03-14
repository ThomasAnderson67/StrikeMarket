import { PublicKey } from "@solana/web3.js";
import { SolanaService } from "./solana.js";
import { PolymarketService, ChallengeMarket, MarketOutcome } from "./polymarket.js";
import { MinerPrediction, MinerScore, scoreAllMiners } from "./scoring.js";
import { Config, calculateTier } from "../config.js";

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

export class EpochManager {
  private solana: SolanaService;
  private polymarket: PolymarketService;
  private config: Config;

  /** Current epoch's challenge markets (cached at epoch start) */
  private challengeMarkets: ChallengeMarket[] = [];

  /** Resolved outcomes (cached after reveal window) */
  private outcomes: MarketOutcome[] = [];

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

    // 5. Fund the epoch
    const fundTxSig = await this.solana.fundEpoch(
      epochId,
      this.config.epochRewardAmount
    );
    console.log(`[epoch] Funded epoch ${epochId} (tx: ${fundTxSig})`);

    return { scores, fundTxSig };
  }

  /**
   * Advance to the next epoch on-chain.
   */
  async advanceEpoch(marketCount: number): Promise<string> {
    return this.solana.advanceEpoch(marketCount);
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
