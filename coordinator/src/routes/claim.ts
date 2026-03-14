import { FastifyInstance } from "fastify";
import { PublicKey } from "@solana/web3.js";
import { authHook, AuthService } from "../middleware/auth.js";
import { SolanaService } from "../services/solana.js";

export function registerClaimRoutes(
  app: FastifyInstance,
  authService: AuthService,
  solana: SolanaService
) {
  // GET /v1/claim-calldata — Get unsigned claim transaction
  app.get<{
    Querystring: { epochs: string; miner: string; minerTokenAccount: string };
  }>(
    "/v1/claim-calldata",
    { preHandler: authHook(authService) },
    async (request, reply) => {
      const { epochs, miner, minerTokenAccount } = request.query;
      if (!epochs || !miner || !minerTokenAccount) {
        return reply
          .status(400)
          .send({ error: "Missing 'epochs', 'miner', or 'minerTokenAccount'" });
      }

      const MAX_CLAIM_EPOCHS = 20;
      const epochIds = epochs.split(",").map(Number);
      if (epochIds.some(isNaN)) {
        return reply.status(400).send({ error: "Invalid epoch format" });
      }
      if (epochIds.length > MAX_CLAIM_EPOCHS) {
        return reply.status(400).send({ error: `Too many epochs (max ${MAX_CLAIM_EPOCHS})` });
      }

      try {
        const minerPubkey = new PublicKey(miner);
        const minerTokenPubkey = new PublicKey(minerTokenAccount);

        // Build one transaction per epoch (they might fail independently)
        const transactions: Array<{
          epochId: number;
          transaction: string;
        }> = [];

        for (const epochId of epochIds) {
          const tx = await solana.buildClaimTx(minerPubkey, epochId, minerTokenPubkey);
          transactions.push({ epochId, transaction: tx });
        }

        return { transactions };
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ error: "Failed to build claim transactions" });
      }
    }
  );

  // GET /v1/close-commitment-calldata — Get unsigned close commitment transaction
  app.get<{
    Querystring: { epochId: string; miner: string; marketId: string };
  }>(
    "/v1/close-commitment-calldata",
    { preHandler: authHook(authService) },
    async (request, reply) => {
      const { epochId, miner, marketId } = request.query;
      if (!epochId || !miner || !marketId) {
        return reply
          .status(400)
          .send({ error: "Missing 'epochId', 'miner', or 'marketId'" });
      }

      try {
        const transaction = await solana.buildCloseCommitmentTx(
          new PublicKey(miner),
          Number(epochId),
          Buffer.from(marketId, "hex")
        );

        return { transaction };
      } catch (err) {
        request.log.error(err);
        return reply
          .status(500)
          .send({ error: "Failed to build close commitment transaction" });
      }
    }
  );
}
