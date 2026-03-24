import { EpochManager } from "./epoch.js";
import { SolanaService } from "./solana.js";
import { Config } from "../config.js";
import { sendAlert } from "./alerts.js";

// ── Epoch Scheduler ──────────────────────────────────────────────────
//
// Drives the epoch lifecycle automatically based on on-chain timing.
//
// State machine:
//
//   ┌──────────┐  T=0h      ┌──────────┐  T=22h     ┌──────────┐
//   │  IDLE /  │──────────►│ COMMIT   │──────────►│   GAP    │
//   │  BOOT    │           │ WINDOW   │           │          │
//   └──────────┘           └──────────┘           └──────────┘
//        ▲                                             │
//        │                                        T=24h│
//        │                                             ▼
//   ┌──────────┐  T=26h+    ┌──────────┐         ┌──────────┐
//   │ ADVANCE  │◄──────────│ SCORING  │◄────────│  REVEAL  │
//   │ (next)   │           │ & FUND   │  T=26h  │  WINDOW  │
//   └──────────┘           └──────────┘         └──────────┘
//
// The scheduler polls on-chain epoch state every POLL_INTERVAL_MS and
// triggers transitions when the clock crosses phase boundaries.
// All timing is derived from on-chain state (epoch_start + offsets).

/** Scheduler phase — derived from on-chain timing */
export type SchedulerPhase =
  | "booting"
  | "commit"
  | "gap"
  | "reveal"
  | "scoring"
  | "advancing"
  | "idle";

export interface SchedulerStatus {
  phase: SchedulerPhase;
  epochId: number;
  epochStart: number;
  commitEnd: number;
  revealStart: number;
  revealEnd: number;
  nextTransition: number;
  running: boolean;
  /** True if the current epoch was skipped due to zero eligible markets */
  skippedEpoch: boolean;
  /** Current round ID within the epoch (0 if none) */
  currentRoundId: number;
  /** Total rounds started in this epoch */
  totalRounds: number;
}

/** How often to poll on-chain state (default 30s) */
const POLL_INTERVAL_MS = parseInt(process.env.SCHEDULER_POLL_MS || "30000");

/** Delay after reveal ends before starting scoring (allow stragglers) */
const SCORING_DELAY_MS = parseInt(process.env.SCORING_DELAY_MS || "10000");

/** Round interval: how often to start a new 15-min round (default 15 min) */
const ROUND_INTERVAL_MS = parseInt(process.env.ROUND_INTERVAL_MS || "900000");

export class EpochScheduler {
  private epochManager: EpochManager;
  private solana: SolanaService;
  private config: Config;

  private timer: ReturnType<typeof setInterval> | null = null;
  private roundTimer: ReturnType<typeof setInterval> | null = null;
  private resolveTimer: ReturnType<typeof setInterval> | null = null;
  private phase: SchedulerPhase = "booting";
  private epochId = 0;
  private epochStart = 0;
  private commitEnd = 0;
  private revealStart = 0;
  private revealEnd = 0;
  private scoring = false; // guard against concurrent scoring
  private scoringFailed = false; // retry flag when scoring errors out
  private skippedEpoch = false; // true if current epoch was auto-skipped (zero markets)

  constructor(config: Config, solana: SolanaService, epochManager: EpochManager) {
    this.config = config;
    this.solana = solana;
    this.epochManager = epochManager;
  }

  /** Start the scheduler loop */
  async start(): Promise<void> {
    console.log(`[scheduler] Starting (poll interval: ${POLL_INTERVAL_MS}ms)`);

    // Initial sync
    await this.syncFromChain();
    this.updatePhase();

    // If we're booting into commit phase, start the epoch (scan markets)
    if (this.phase === "commit") {
      await this.onCommitPhaseStart();
    }

    this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
  }

  /** Stop the scheduler loop */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopRoundTimers();
    console.log("[scheduler] Stopped");
  }

  /** Get current scheduler status */
  getStatus(): SchedulerStatus {
    const currentRound = this.epochManager.getCurrentRound();
    return {
      phase: this.phase,
      epochId: this.epochId,
      epochStart: this.epochStart,
      commitEnd: this.commitEnd,
      revealStart: this.revealStart,
      revealEnd: this.revealEnd,
      nextTransition: this.getNextTransitionTime(),
      running: this.timer !== null,
      skippedEpoch: this.skippedEpoch,
      currentRoundId: currentRound?.roundId ?? 0,
      totalRounds: this.epochManager.getRounds().length,
    };
  }

  // ── Core loop ──────────────────────────────────────────────────

  private async tick(): Promise<void> {
    try {
      const prevPhase = this.phase;
      this.updatePhase();

      if (this.phase !== prevPhase) {
        console.log(`[scheduler] Phase transition: ${prevPhase} → ${this.phase}`);
        await this.onPhaseTransition(prevPhase, this.phase);
      } else if (this.phase === "scoring" && this.scoringFailed && !this.scoring) {
        // Retry scoring after a previous failure
        console.log(`[scheduler] Retrying scoring for epoch ${this.epochId}`);
        this.scoringFailed = false;
        await this.onScoringPhase();
      }
    } catch (err) {
      console.error(`[scheduler] Tick error: ${err}`);
    }
  }

  /** Determine current phase from on-chain timing */
  private updatePhase(): void {
    const now = Math.floor(Date.now() / 1000);

    if (this.epochStart === 0) {
      this.phase = "booting";
      return;
    }

    if (now < this.commitEnd) {
      this.phase = "commit";
    } else if (now < this.revealStart) {
      this.phase = "gap";
    } else if (now < this.revealEnd) {
      this.phase = "reveal";
    } else if (!this.scoring) {
      // Past reveal end — need to score and advance
      this.phase = "scoring";
    }
  }

  /** Handle phase transitions */
  private async onPhaseTransition(from: SchedulerPhase, to: SchedulerPhase): Promise<void> {
    switch (to) {
      case "commit":
        if (from === "booting" || from === "advancing") {
          await this.onCommitPhaseStart();
        }
        break;

      case "scoring":
        await this.onScoringPhase();
        break;

      // gap and reveal phases are passive — miners interact via API
    }
  }

  /** Scan markets and build challenge set at epoch start, start round timers */
  private async onCommitPhaseStart(): Promise<void> {
    console.log(`[scheduler] Epoch ${this.epochId} commit phase started`);
    this.skippedEpoch = false;
    try {
      const result = await this.epochManager.startEpoch();
      if (result.skipped) {
        console.log(
          `[scheduler] No eligible markets — auto-skipping epoch ${this.epochId}`
        );
        this.skippedEpoch = true;
        await this.autoSkipEpoch();
      } else {
        console.log(`[scheduler] Challenge set ready: ${result.marketCount} markets`);
        this.startRoundTimers();
      }
    } catch (err) {
      console.error(`[scheduler] Failed to start epoch: ${err}`);
    }
  }

  /**
   * Auto-skip an epoch with zero eligible markets.
   * Advances on-chain to the next epoch immediately, then re-syncs.
   */
  private async autoSkipEpoch(): Promise<void> {
    try {
      // Advance on-chain with 0 markets
      const advanceTx = await this.epochManager.advanceEpoch(0);
      console.log(
        `[scheduler] Auto-skipped epoch ${this.epochId}, advanced on-chain (tx: ${advanceTx})`
      );

      // Re-sync from chain to pick up the new epoch
      await this.syncFromChain();
      this.skippedEpoch = false;

      // Start the new epoch (scan markets again for the next epoch)
      const result = await this.epochManager.startEpoch();
      if (result.skipped) {
        // Still no markets — stay in commit phase but mark as skipped.
        // The next tick will re-evaluate. Don't recurse infinitely.
        console.log(
          `[scheduler] Next epoch ${this.epochId} also has no markets. Waiting for next poll.`
        );
        this.skippedEpoch = true;
      } else {
        console.log(
          `[scheduler] New epoch ${this.epochId} has ${result.marketCount} markets`
        );
      }
      this.updatePhase();
    } catch (err) {
      console.error(`[scheduler] Auto-skip failed: ${err}`);
      this.skippedEpoch = true;
      await sendAlert(
        `Epoch ${this.epochId} auto-skip failed`,
        String(err),
      );
    }
  }

  /** Score miners, fund epoch, advance to next epoch */
  private async onScoringPhase(): Promise<void> {
    if (this.scoring) return; // prevent re-entry
    this.scoring = true;
    this.stopRoundTimers();

    console.log(`[scheduler] Epoch ${this.epochId} scoring phase started`);

    try {
      // Wait a short delay for any last-second reveals to land
      await this.delay(SCORING_DELAY_MS);

      // 1. Close epoch: resolve outcomes, score miners, fund
      const challengeCount = this.epochManager.getChallengeMarkets().length;
      if (challengeCount > 0) {
        const { scores, fundTxSig } = await this.epochManager.closeEpoch(this.epochId);
        console.log(
          `[scheduler] Epoch ${this.epochId} closed: ${scores.length} miners scored, fund tx: ${fundTxSig}`
        );
      } else {
        console.log(`[scheduler] Epoch ${this.epochId} had no challenges, skipping scoring`);
      }

      // 2. Advance epoch on-chain
      this.phase = "advancing";
      const nextMarketResult = await this.epochManager.startEpoch();
      const advanceTx = await this.epochManager.advanceEpoch(nextMarketResult.marketCount);
      console.log(`[scheduler] Advanced to epoch ${this.epochId + 1} (tx: ${advanceTx})`);

      // 3. Re-sync from chain to pick up new epoch
      await this.syncFromChain();
      this.updatePhase();

      console.log(`[scheduler] Now in epoch ${this.epochId}, phase: ${this.phase}`);
    } catch (err) {
      console.error(`[scheduler] Scoring/advance failed: ${err}`);
      this.scoringFailed = true;
      await sendAlert(
        `Epoch ${this.epochId} scoring/advance failed`,
        String(err),
      );
    } finally {
      this.scoring = false;
    }
  }

  // ── Round timers ──────────────────────────────────────────────

  /** Start the round timer: every ROUND_INTERVAL_MS, start a new round and try to resolve past rounds */
  private startRoundTimers(): void {
    this.stopRoundTimers();

    // Start new rounds periodically
    this.roundTimer = setInterval(async () => {
      try {
        if (this.phase !== "commit" && this.phase !== "gap" && this.phase !== "reveal") {
          return; // Only start rounds during the epoch
        }

        // Don't start new rounds past the commit window
        const now = Math.floor(Date.now() / 1000);
        if (now >= this.commitEnd) {
          console.log("[scheduler] Past commit window — not starting new rounds");
          return;
        }

        const round = await this.epochManager.startRound();
        if (round) {
          console.log(
            `[scheduler] Started round ${round.roundId}: ${round.markets.length} markets`
          );
        }
      } catch (err) {
        console.error(`[scheduler] Round start error: ${err}`);
      }
    }, ROUND_INTERVAL_MS);

    // Resolve past rounds periodically (check every 30s)
    this.resolveTimer = setInterval(async () => {
      try {
        const rounds = this.epochManager.getRounds();
        const now = Math.floor(Date.now() / 1000);

        for (const round of rounds) {
          if (round.resolved) continue;
          // Only try to resolve rounds whose end time has passed
          if (now < round.endsAt) continue;

          await this.epochManager.resolveRound(round.roundId);
        }
      } catch (err) {
        console.error(`[scheduler] Round resolve error: ${err}`);
      }
    }, POLL_INTERVAL_MS);

    console.log(
      `[scheduler] Round timers started: new round every ${ROUND_INTERVAL_MS / 1000}s, ` +
      `resolve check every ${POLL_INTERVAL_MS / 1000}s`
    );
  }

  /** Stop round timers */
  private stopRoundTimers(): void {
    if (this.roundTimer) {
      clearInterval(this.roundTimer);
      this.roundTimer = null;
    }
    if (this.resolveTimer) {
      clearInterval(this.resolveTimer);
      this.resolveTimer = null;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────

  /** Force re-sync from chain (used by admin endpoints) */
  async resync(): Promise<void> {
    await this.syncFromChain();
    this.scoring = false;
    this.scoringFailed = false;
    this.skippedEpoch = false;
    this.updatePhase();
  }

  /** Read on-chain state to sync epoch timing */
  private async syncFromChain(): Promise<void> {
    try {
      const globalState = await this.solana.getGlobalState();
      this.epochId = (globalState as any).currentEpoch.toNumber();

      const epochDuration = (globalState as any).epochDuration.toNumber();
      const commitEndOffset = (globalState as any).commitEndOffset.toNumber();
      const revealStartOffset = (globalState as any).revealStartOffset.toNumber();
      const revealEndOffset = (globalState as any).revealEndOffset.toNumber();

      const epochState = await this.solana.getEpochState(this.epochId);
      this.epochStart = (epochState as any).epochStart.toNumber();

      this.commitEnd = this.epochStart + commitEndOffset;
      this.revealStart = this.epochStart + revealStartOffset;
      this.revealEnd = this.epochStart + revealEndOffset;

      console.log(
        `[scheduler] Synced: epoch=${this.epochId}, start=${new Date(this.epochStart * 1000).toISOString()}, ` +
        `commitEnd=${new Date(this.commitEnd * 1000).toISOString()}, ` +
        `revealStart=${new Date(this.revealStart * 1000).toISOString()}, ` +
        `revealEnd=${new Date(this.revealEnd * 1000).toISOString()}`
      );
    } catch (err) {
      console.error(`[scheduler] Failed to sync from chain: ${err}`);
    }
  }

  private getNextTransitionTime(): number {
    const now = Math.floor(Date.now() / 1000);
    if (now < this.commitEnd) return this.commitEnd;
    if (now < this.revealStart) return this.revealStart;
    if (now < this.revealEnd) return this.revealEnd;
    return 0; // past all transitions
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
