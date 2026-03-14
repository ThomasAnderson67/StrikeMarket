import { FastifyInstance } from "fastify";
import { SolanaService } from "../services/solana.js";

export function registerEpochRoutes(app: FastifyInstance, solana: SolanaService) {
  // GET /v1/epoch — Current epoch info
  app.get("/v1/epoch", async (_request, reply) => {
    try {
      const globalState = await solana.getGlobalState();
      const currentEpoch = (globalState as any).currentEpoch.toNumber();
      const epochState = await solana.getEpochState(currentEpoch);

      const epochStart = (epochState as any).epochStart.toNumber();
      const epochDuration = (globalState as any).epochDuration.toNumber();
      const commitEndOffset = (globalState as any).commitEndOffset.toNumber();
      const revealStartOffset = (globalState as any).revealStartOffset.toNumber();
      const revealEndOffset = (globalState as any).revealEndOffset.toNumber();

      return {
        epochId: currentEpoch,
        prevEpochId: currentEpoch > 1 ? currentEpoch - 1 : null,
        epochStart,
        nextEpochStartTimestamp: epochStart + epochDuration,
        commitDeadline: epochStart + commitEndOffset,
        revealWindowStart: epochStart + revealStartOffset,
        revealWindowEnd: epochStart + revealEndOffset,
        epochDurationSeconds: epochDuration,
        marketCount: (epochState as any).marketCount,
        totalCredits: (epochState as any).totalCredits.toNumber(),
        funded: (epochState as any).funded,
      };
    } catch (err) {
      return reply.status(500).send({ error: "Failed to fetch epoch info" });
    }
  });

  // GET /v1/credits — Miner's credits per epoch
  app.get<{
    Querystring: { miner: string };
  }>("/v1/credits", async (request, reply) => {
    const { miner } = request.query;
    if (!miner) {
      return reply.status(400).send({ error: "Missing 'miner' query param" });
    }

    try {
      const { PublicKey } = await import("@solana/web3.js");
      const minerPubkey = new PublicKey(miner);

      const globalState = await solana.getGlobalState();
      const currentEpoch = (globalState as any).currentEpoch.toNumber();

      // Check last 10 epochs for credits
      const credits: Array<{
        epochId: number;
        credits: number;
        claimed: boolean;
      }> = [];

      for (let e = Math.max(1, currentEpoch - 10); e <= currentEpoch; e++) {
        const record = await solana.getMinerEpochRecord(e, minerPubkey);
        if (record) {
          credits.push({
            epochId: e,
            credits: (record as any).credits.toNumber(),
            claimed: (record as any).claimed,
          });
        }
      }

      return { miner, credits };
    } catch (err) {
      return reply.status(500).send({ error: "Failed to fetch credits" });
    }
  });
}
