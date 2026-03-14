import { FastifyInstance } from "fastify";
import { authHook, AuthService } from "../middleware/auth.js";
import { EpochManager } from "../services/epoch.js";
import { SolanaService } from "../services/solana.js";

export function registerChallengeRoutes(
  app: FastifyInstance,
  authService: AuthService,
  epochManager: EpochManager,
  solana: SolanaService
) {
  // GET /v1/challenge — Get current epoch's challenge set (market list)
  app.get(
    "/v1/challenge",
    { preHandler: authHook(authService) },
    async (request, reply) => {
      const miner = (request as any).miner as string;
      const tier = (request as any).tier as number;

      try {
        const globalState = await solana.getGlobalState();
        const currentEpoch = (globalState as any).currentEpoch.toNumber();
        const epochState = await solana.getEpochState(currentEpoch);
        const epochStart = (epochState as any).epochStart.toNumber();
        const commitEndOffset = (globalState as any).commitEndOffset.toNumber();

        const now = Math.floor(Date.now() / 1000);
        const commitDeadline = epochStart + commitEndOffset;

        const markets = epochManager.getChallengeMarkets();

        if (markets.length === 0) {
          return reply.status(200).send({
            epochId: currentEpoch,
            markets: [],
            message: "No eligible markets this epoch. Epoch will be skipped.",
            skipped: true,
          });
        }

        return {
          epochId: currentEpoch,
          epochStart,
          commitDeadline,
          creditsPerSolve: tier,
          marketCount: markets.length,
          markets: markets.map((m) => ({
            marketId: m.marketId.toString("hex"),
            sourceMarketId: m.sourceMarketId,
            question: m.question,
          })),
        };
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ error: "Failed to fetch challenge" });
      }
    }
  );
}
