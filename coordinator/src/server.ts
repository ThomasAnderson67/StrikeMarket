import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { loadConfig } from "./config.js";
import { SolanaService } from "./services/solana.js";
import { PolymarketService } from "./services/polymarket.js";
import { EpochManager } from "./services/epoch.js";
import { EpochScheduler } from "./services/scheduler.js";
import { AuthService } from "./middleware/auth.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerChallengeRoutes } from "./routes/challenge.js";
import { registerSubmitRoutes } from "./routes/submit.js";
import { registerEpochRoutes } from "./routes/epoch.js";
import { registerClaimRoutes } from "./routes/claim.js";

// ── Strike Coordinator Server ──────────────────────────────────────────
//
// Architecture:
//   Fastify HTTP server → route handlers → services → Solana RPC
//
// Services:
//   SolanaService  — TX builder, state reader, admin operations
//   PolymarketService — Market discovery, outcome resolution
//   EpochManager   — Epoch lifecycle (start, score, fund, advance)
//   AuthService    — Nonce/sign/verify, JWT, replay protection
//
// API endpoints:
//   POST /v1/auth/nonce          — Request signing nonce
//   POST /v1/auth/verify         — Verify signature, get JWT
//   GET  /v1/challenge           — Get challenge set (auth required)
//   POST /v1/submit-commit       — Get unsigned commit TX (auth required)
//   POST /v1/submit-reveal       — Get unsigned reveal TX (auth required)
//   POST /v1/submit-stake        — Get unsigned stake TX (auth required)
//   POST /v1/submit-unstake      — Get unsigned unstake TX (auth required)
//   POST /v1/submit-withdraw     — Get unsigned withdraw TX (auth required)
//   GET  /v1/epoch               — Current epoch info (public)
//   GET  /v1/credits             — Miner credits per epoch (public)
//   GET  /v1/claim-calldata      — Get unsigned claim TX (auth required)
//   GET  /v1/close-commitment-calldata — Get unsigned close TX (auth required)
//   GET  /v1/health              — Health check (public)

async function main() {
  const config = loadConfig();

  // Initialize services
  const solana = new SolanaService(config);
  const polymarket = new PolymarketService();
  const epochManager = new EpochManager(config, solana, polymarket);
  const authService = new AuthService(config, solana);

  // Create Fastify app
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
    },
  });

  // Security headers
  app.addHook('onSend', (request, reply, payload, done) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    done();
  });

  // CORS for dashboard
  await app.register(cors, { origin: true });

  // Rate limiting (global default + stricter on auth)
  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });

  // Health check
  app.get("/v1/health", async () => {
    try {
      const globalState = await solana.getGlobalState();
      return {
        status: "ok",
        currentEpoch: (globalState as any).currentEpoch.toNumber(),
        challengeMarkets: epochManager.getChallengeMarkets().length,
      };
    } catch {
      return { status: "ok", currentEpoch: null, challengeMarkets: 0 };
    }
  });

  // Register route modules
  registerAuthRoutes(app, authService);
  registerChallengeRoutes(app, authService, epochManager, solana);
  registerSubmitRoutes(app, authService, solana, epochManager);
  registerEpochRoutes(app, solana);
  registerClaimRoutes(app, authService, solana);

  // Epoch detail endpoints (for landing page)
  app.get("/v1/epochs", async () => {
    return epochManager.getEpochList();
  });

  app.get<{ Params: { id: string } }>("/v1/epoch/:id/details", async (request, reply) => {
    const epochId = Number(request.params.id);
    if (isNaN(epochId)) {
      return reply.status(400).send({ error: "Invalid epoch ID" });
    }
    const detail = epochManager.getEpochDetail(epochId);
    if (!detail) {
      // If this is the current epoch, return 200 with in_progress status instead of 404
      const currentEpoch = scheduler.getStatus().epochId;
      if (epochId === currentEpoch) {
        return { status: "in_progress", message: "Epoch is still active. Details available after scoring completes." };
      }
      return reply.status(404).send({ error: "Epoch detail not found" });
    }
    return detail;
  });

  // Initialize epoch scheduler
  const scheduler = new EpochScheduler(config, solana, epochManager);

  // Current round info
  app.get("/v1/round", async () => {
    const currentRound = epochManager.getCurrentRound();
    const schedulerStatus = scheduler.getStatus();

    if (!currentRound) {
      return {
        active: false,
        message: "No active round. Waiting for next 15-min round.",
        epochId: schedulerStatus.epochId,
        totalRounds: epochManager.getRounds().length,
      };
    }

    return {
      active: true,
      roundId: currentRound.roundId,
      roundStartedAt: currentRound.startedAt,
      roundEndsAt: currentRound.endsAt,
      marketsCount: currentRound.markets.length,
      resolved: currentRound.resolved,
      epochId: schedulerStatus.epochId,
      totalRounds: epochManager.getRounds().length,
    };
  });

  // Expose scheduler status
  app.get("/v1/scheduler", async () => scheduler.getStatus());

  // Admin: force advance epoch (skips scoring/funding for stuck epochs)
  app.post("/v1/admin/force-advance", async (request, reply) => {
    try {
      const nextMarkets = await epochManager.startEpoch();
      const txSig = await epochManager.advanceEpoch(nextMarkets.marketCount);
      // Re-sync scheduler to pick up the new epoch
      await scheduler.resync();
      return { success: true, tx: txSig, nextMarketCount: nextMarkets.marketCount };
    } catch (err) {
      return reply.status(500).send({ error: "Force advance failed", detail: String(err) });
    }
  });

  // Dashboard stats endpoint (cached 60s to avoid RPC storms)
  const STATS_CACHE_TTL_MS = 60_000;
  let statsCache: { data: any; expiresAt: number } | null = null;

  app.get("/v1/stats", async () => {
    if (statsCache && Date.now() < statsCache.expiresAt) {
      return statsCache.data;
    }
    try {
      const globalState = await solana.getGlobalState();
      const currentEpoch = (globalState as any).currentEpoch.toNumber();
      const epochState = await solana.getEpochState(currentEpoch);

      const [vaultBalance, minerStats, totalMined] = await Promise.all([
        solana.getVaultBalance(),
        solana.getMinerStats(),
        solana.getTotalMined(currentEpoch),
      ]);

      const schedulerStatus = scheduler.getStatus();

      const result = {
        currentEpoch,
        phase: schedulerStatus.phase,
        activeMiners: minerStats.activeMiners,
        totalMiners: minerStats.totalMiners,
        totalStaked: minerStats.totalStaked.toString(),
        totalStakedFormatted: Number(minerStats.totalStaked / BigInt(10 ** 6)),
        totalMined: totalMined.toString(),
        totalMinedFormatted: Number(totalMined / BigInt(10 ** 6)),
        vaultBalance: vaultBalance.amount,
        vaultBalanceFormatted: Number(vaultBalance.uiAmount),
        epochRewardAmount: config.epochRewardAmount.toString(),
        epochRewardFormatted: Number(config.epochRewardAmount / BigInt(10 ** 6)),
        marketCount: (epochState as any).marketCount,
        totalCredits: (epochState as any).totalCredits.toNumber(),
        funded: (epochState as any).funded,
        epochStart: (epochState as any).epochStart.toNumber(),
        nextTransition: schedulerStatus.nextTransition,
      };
      statsCache = { data: result, expiresAt: Date.now() + STATS_CACHE_TTL_MS };
      return result;
    } catch (err) {
      return { error: "Failed to fetch stats", detail: String(err) };
    }
  });

  // Start server
  await app.listen({ port: config.port, host: config.host });
  console.log(
    `[server] Strike Coordinator running on ${config.host}:${config.port}`
  );

  // Start scheduler after server is listening
  await scheduler.start();

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[server] Shutting down...");
    scheduler.stop();
    authService.stop();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
