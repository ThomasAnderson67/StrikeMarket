import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { SolanaService } from "./services/solana.js";
import { DriftService } from "./services/drift.js";
import { EpochManager } from "./services/epoch.js";
import { AuthService } from "./middleware/auth.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerChallengeRoutes } from "./routes/challenge.js";
import { registerSubmitRoutes } from "./routes/submit.js";
import { registerEpochRoutes } from "./routes/epoch.js";
import { registerClaimRoutes } from "./routes/claim.js";

// ── ENELBOT Coordinator Server ─────────────────────────────────────────
//
// Architecture:
//   Fastify HTTP server → route handlers → services → Solana RPC
//
// Services:
//   SolanaService  — TX builder, state reader, admin operations
//   DriftService   — Market discovery, outcome resolution
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
  const drift = new DriftService();
  const epochManager = new EpochManager(config, solana, drift);
  const authService = new AuthService(config, solana);

  // Create Fastify app
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
    },
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

  // Start epoch on boot (scan markets, build challenge set)
  try {
    const result = await epochManager.startEpoch();
    if (result.skipped) {
      console.log("[boot] No markets available. Waiting for next epoch.");
    } else {
      console.log(`[boot] Challenge set ready: ${result.marketCount} markets`);
    }
  } catch (err) {
    console.error("[boot] Failed to initialize epoch:", err);
  }

  // Start server
  await app.listen({ port: config.port, host: config.host });
  console.log(
    `[server] ENELBOT Coordinator running on ${config.host}:${config.port}`
  );

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[server] Shutting down...");
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
