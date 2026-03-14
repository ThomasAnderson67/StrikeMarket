import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EpochScheduler, SchedulerPhase } from "../src/services/scheduler.js";

// ── Mocks ────────────────────────────────────────────────────────────

function makeMockSolana(overrides: Record<string, unknown> = {}) {
  const defaults = {
    epochId: 1,
    epochStart: Math.floor(Date.now() / 1000) - 3600, // started 1h ago
    epochDuration: 86400,
    commitEndOffset: 79200,
    revealStartOffset: 86400,
    revealEndOffset: 93600,
  };
  const merged = { ...defaults, ...overrides };

  return {
    getGlobalState: vi.fn().mockResolvedValue({
      currentEpoch: { toNumber: () => merged.epochId },
      epochDuration: { toNumber: () => merged.epochDuration },
      commitEndOffset: { toNumber: () => merged.commitEndOffset },
      revealStartOffset: { toNumber: () => merged.revealStartOffset },
      revealEndOffset: { toNumber: () => merged.revealEndOffset },
    }),
    getEpochState: vi.fn().mockResolvedValue({
      epochStart: { toNumber: () => merged.epochStart },
    }),
  };
}

function makeMockEpochManager() {
  return {
    startEpoch: vi.fn().mockResolvedValue({ marketCount: 5, skipped: false }),
    closeEpoch: vi.fn().mockResolvedValue({ scores: [], fundTxSig: "sig123" }),
    advanceEpoch: vi.fn().mockResolvedValue("adv-sig"),
    getChallengeMarkets: vi.fn().mockReturnValue([{ marketId: Buffer.alloc(32) }]),
    getOutcomes: vi.fn().mockReturnValue([]),
  };
}

function makeMockConfig() {
  return { epochRewardAmount: 1000000000000n } as any;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("EpochScheduler", () => {
  let scheduler: EpochScheduler;
  let solana: ReturnType<typeof makeMockSolana>;
  let epochManager: ReturnType<typeof makeMockEpochManager>;

  afterEach(() => {
    scheduler?.stop();
  });

  describe("getStatus", () => {
    it("returns booting phase before start", () => {
      solana = makeMockSolana();
      epochManager = makeMockEpochManager();
      scheduler = new EpochScheduler(makeMockConfig(), solana as any, epochManager as any);

      const status = scheduler.getStatus();
      expect(status.phase).toBe("booting");
      expect(status.running).toBe(false);
    });

    it("returns commit phase when within commit window", async () => {
      const now = Math.floor(Date.now() / 1000);
      solana = makeMockSolana({ epochStart: now - 3600 }); // started 1h ago
      epochManager = makeMockEpochManager();
      scheduler = new EpochScheduler(makeMockConfig(), solana as any, epochManager as any);

      await scheduler.start();

      const status = scheduler.getStatus();
      expect(status.phase).toBe("commit");
      expect(status.running).toBe(true);
      expect(status.epochId).toBe(1);
    });

    it("returns gap phase between commit and reveal", async () => {
      const now = Math.floor(Date.now() / 1000);
      // epoch started 23h ago → commit ended at 22h, reveal starts at 24h
      solana = makeMockSolana({ epochStart: now - 82800 });
      epochManager = makeMockEpochManager();
      scheduler = new EpochScheduler(makeMockConfig(), solana as any, epochManager as any);

      await scheduler.start();

      expect(scheduler.getStatus().phase).toBe("gap");
    });

    it("returns reveal phase during reveal window", async () => {
      const now = Math.floor(Date.now() / 1000);
      // epoch started 25h ago → reveal is 24-26h
      solana = makeMockSolana({ epochStart: now - 90000 });
      epochManager = makeMockEpochManager();
      scheduler = new EpochScheduler(makeMockConfig(), solana as any, epochManager as any);

      await scheduler.start();

      expect(scheduler.getStatus().phase).toBe("reveal");
    });

    it("returns scoring phase after reveal window", async () => {
      const now = Math.floor(Date.now() / 1000);
      // epoch started 27h ago → past reveal end (26h)
      solana = makeMockSolana({ epochStart: now - 97200 });
      epochManager = makeMockEpochManager();
      scheduler = new EpochScheduler(makeMockConfig(), solana as any, epochManager as any);

      // Don't call start() — it would trigger scoring. Just sync and check phase.
      await (scheduler as any).syncFromChain();
      (scheduler as any).updatePhase();

      expect(scheduler.getStatus().phase).toBe("scoring");
    });
  });

  describe("phase transitions", () => {
    it("calls startEpoch when booting into commit phase", async () => {
      const now = Math.floor(Date.now() / 1000);
      solana = makeMockSolana({ epochStart: now - 3600 });
      epochManager = makeMockEpochManager();
      scheduler = new EpochScheduler(makeMockConfig(), solana as any, epochManager as any);

      await scheduler.start();

      expect(epochManager.startEpoch).toHaveBeenCalledOnce();
    });

    it("does not call startEpoch when booting into gap phase", async () => {
      const now = Math.floor(Date.now() / 1000);
      solana = makeMockSolana({ epochStart: now - 82800 }); // gap phase
      epochManager = makeMockEpochManager();
      scheduler = new EpochScheduler(makeMockConfig(), solana as any, epochManager as any);

      await scheduler.start();

      expect(epochManager.startEpoch).not.toHaveBeenCalled();
    });

    it("handles skipped epoch (no markets)", async () => {
      const now = Math.floor(Date.now() / 1000);
      solana = makeMockSolana({ epochStart: now - 3600 });
      epochManager = makeMockEpochManager();
      epochManager.startEpoch.mockResolvedValue({ marketCount: 0, skipped: true });
      scheduler = new EpochScheduler(makeMockConfig(), solana as any, epochManager as any);

      await scheduler.start();

      expect(epochManager.startEpoch).toHaveBeenCalledOnce();
      // Should not throw
    });
  });

  describe("nextTransition", () => {
    it("returns commitEnd when in commit phase", async () => {
      const now = Math.floor(Date.now() / 1000);
      const epochStart = now - 3600;
      solana = makeMockSolana({ epochStart });
      epochManager = makeMockEpochManager();
      scheduler = new EpochScheduler(makeMockConfig(), solana as any, epochManager as any);

      await scheduler.start();

      const status = scheduler.getStatus();
      expect(status.nextTransition).toBe(epochStart + 79200);
    });

    it("returns revealStart when in gap phase", async () => {
      const now = Math.floor(Date.now() / 1000);
      const epochStart = now - 82800;
      solana = makeMockSolana({ epochStart });
      epochManager = makeMockEpochManager();
      scheduler = new EpochScheduler(makeMockConfig(), solana as any, epochManager as any);

      await scheduler.start();

      const status = scheduler.getStatus();
      expect(status.nextTransition).toBe(epochStart + 86400);
    });

    it("returns revealEnd when in reveal phase", async () => {
      const now = Math.floor(Date.now() / 1000);
      const epochStart = now - 90000;
      solana = makeMockSolana({ epochStart });
      epochManager = makeMockEpochManager();
      scheduler = new EpochScheduler(makeMockConfig(), solana as any, epochManager as any);

      await scheduler.start();

      const status = scheduler.getStatus();
      expect(status.nextTransition).toBe(epochStart + 93600);
    });

    it("returns 0 when past all transitions", async () => {
      const now = Math.floor(Date.now() / 1000);
      solana = makeMockSolana({ epochStart: now - 97200 });
      epochManager = makeMockEpochManager();
      scheduler = new EpochScheduler(makeMockConfig(), solana as any, epochManager as any);

      await (scheduler as any).syncFromChain();
      (scheduler as any).updatePhase();

      expect(scheduler.getStatus().nextTransition).toBe(0);
    });
  });

  describe("stop", () => {
    it("clears the interval and marks not running", async () => {
      const now = Math.floor(Date.now() / 1000);
      solana = makeMockSolana({ epochStart: now - 3600 });
      epochManager = makeMockEpochManager();
      scheduler = new EpochScheduler(makeMockConfig(), solana as any, epochManager as any);

      await scheduler.start();
      expect(scheduler.getStatus().running).toBe(true);

      scheduler.stop();
      expect(scheduler.getStatus().running).toBe(false);
    });
  });

  describe("error handling", () => {
    it("handles chain sync failure gracefully", async () => {
      solana = makeMockSolana();
      solana.getGlobalState.mockRejectedValueOnce(new Error("RPC down"));
      epochManager = makeMockEpochManager();
      scheduler = new EpochScheduler(makeMockConfig(), solana as any, epochManager as any);

      // Should not throw
      await scheduler.start();
      expect(scheduler.getStatus().phase).toBe("booting");
    });

    it("handles startEpoch failure gracefully", async () => {
      const now = Math.floor(Date.now() / 1000);
      solana = makeMockSolana({ epochStart: now - 3600 });
      epochManager = makeMockEpochManager();
      epochManager.startEpoch.mockRejectedValueOnce(new Error("Polymarket down"));
      scheduler = new EpochScheduler(makeMockConfig(), solana as any, epochManager as any);

      // Should not throw
      await scheduler.start();
      expect(scheduler.getStatus().phase).toBe("commit");
    });
  });
});
