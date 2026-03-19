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
  registerSubmitRoutes(app, authService, solana);
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
      return reply.status(404).send({ error: "Epoch detail not found" });
    }
    return detail;
  });

  // Initialize epoch scheduler
  const scheduler = new EpochScheduler(config, solana, epochManager);

  // Expose scheduler status
  app.get("/v1/scheduler", async () => scheduler.getStatus());

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
