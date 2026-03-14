import Fastify from "fastify";
import cors from "@fastify/cors";
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

// ── ENELBOT Coordinator Server ─────────────────────────────────────────
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

  // Initialize epoch scheduler
  const scheduler = new EpochScheduler(config, solana, epochManager);

  // Expose scheduler status
  app.get("/v1/scheduler", async () => scheduler.getStatus());

  // Dashboard stats endpoint
  app.get("/v1/stats", async () => {
    try {
      const globalState = await solana.getGlobalState();
      const currentEpoch = (globalState as any).currentEpoch.toNumber();
      const epochState = await solana.getEpochState(currentEpoch);

      // Vault balance (total staked + rewards)
      const { PublicKey } = await import("@solana/web3.js");
      const [vaultAddr] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault")],
        config.programId
      );
      const vaultBalance = await solana.connection.getTokenAccountBalance(vaultAddr);

      // Count active miners via getProgramAccounts on MinerState
      // MinerState: 8 discriminator + 32 miner + 8 staked_amount + 1 tier + 8 unstake + 1 bump = 58
      const minerAccounts = await solana.connection.getProgramAccounts(config.programId, {
        filters: [{ dataSize: 58 }],
      });

      // Sum staked amounts and count active (tier > 0)
      let totalStaked = BigInt(0);
      let activeMiners = 0;
      for (const { account } of minerAccounts) {
        const data = account.data;
        const stakedAmount = data.readBigUInt64LE(40); // offset: 8 disc + 32 miner
        const tier = data[48]; // offset: 8 + 32 + 8
        if (tier > 0) activeMiners++;
        totalStaked += stakedAmount;
      }

      // Sum total mined (claimed across all epochs)
      let totalMined = BigInt(0);
      for (let e = 1; e < currentEpoch; e++) {
        try {
          const es = await solana.getEpochState(e);
          totalMined += BigInt((es as any).totalClaimed.toNumber());
        } catch {
          // Epoch state may not exist
        }
      }

      const schedulerStatus = scheduler.getStatus();

      return {
        currentEpoch,
        phase: schedulerStatus.phase,
        activeMiners,
        totalMiners: minerAccounts.length,
        totalStaked: totalStaked.toString(),
        totalStakedFormatted: Number(totalStaked / BigInt(10 ** 6)),
        totalMined: totalMined.toString(),
        totalMinedFormatted: Number(totalMined / BigInt(10 ** 6)),
        vaultBalance: vaultBalance.value.amount,
        vaultBalanceFormatted: Number(vaultBalance.value.uiAmount),
        epochRewardAmount: config.epochRewardAmount.toString(),
        epochRewardFormatted: Number(config.epochRewardAmount / BigInt(10 ** 6)),
        marketCount: (epochState as any).marketCount,
        totalCredits: (epochState as any).totalCredits.toNumber(),
        funded: (epochState as any).funded,
        epochStart: (epochState as any).epochStart.toNumber(),
        nextTransition: schedulerStatus.nextTransition,
      };
    } catch (err) {
      return { error: "Failed to fetch stats", detail: String(err) };
    }
  });

  // Start server
  await app.listen({ port: config.port, host: config.host });
  console.log(
    `[server] ENELBOT Coordinator running on ${config.host}:${config.port}`
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
