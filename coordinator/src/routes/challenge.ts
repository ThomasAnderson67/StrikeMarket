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
  // GET /v1/challenge — Get current round's markets (crypto 15-min)
  app.get(
    "/v1/challenge",
    { preHandler: authHook(authService) },
    async (request, reply) => {
      const miner = (request as any).miner as string;
      const tier = (request as any).tier as number;

      try {
        const globalState = await solana.getGlobalState();
        const currentEpoch = (globalState as any).currentEpoch.toNumber();

        const currentRound = epochManager.getCurrentRound();

        if (!currentRound) {
          return reply.status(200).send({
            epochId: currentEpoch,
            markets: [],
            message: "No active round. Waiting for next 15-min round.",
            skipped: true,
          });
        }

        return {
          epochId: currentEpoch,
          roundId: currentRound.roundId,
          roundEndsAt: currentRound.endsAt,
          creditsPerSolve: tier,
          marketCount: currentRound.markets.length,
          totalEpochMarkets: epochManager.getChallengeMarkets().length,
          totalRounds: epochManager.getRounds().length,
          markets: currentRound.markets.map((m) => ({
            marketId: m.marketId.toString("hex"),
            sourceMarketId: m.sourceMarketId,
            question: m.question,
            endDate: m.endDate,
          })),
        };
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ error: "Failed to fetch challenge" });
      }
    }
  );
}
