import { FastifyInstance } from "fastify";
import { PublicKey } from "@solana/web3.js";
import { authHook, AuthService } from "../middleware/auth.js";
import { SolanaService } from "../services/solana.js";
import { EpochManager } from "../services/epoch.js";

export function registerSubmitRoutes(
  app: FastifyInstance,
  authService: AuthService,
  solana: SolanaService,
  epochManager: EpochManager
) {
  // POST /v1/submit-commit — Get unsigned commit transaction
  app.post<{
    Body: {
      miner: string;
      marketId: string; // hex-encoded 32 bytes
      hash: string; // hex-encoded 32 bytes
    };
  }>(
    "/v1/submit-commit",
    { preHandler: authHook(authService) },
    async (request, reply) => {
      const { miner, marketId, hash } = request.body || {};
      if (!miner || !marketId || !hash) {
        return reply
          .status(400)
          .send({ error: "Missing 'miner', 'marketId', or 'hash'" });
      }

      try {
        const minerPubkey = new PublicKey(miner);
        const marketIdBuf = Buffer.from(marketId, "hex");
        const hashBuf = Buffer.from(hash, "hex");

        if (marketIdBuf.length !== 32 || hashBuf.length !== 32) {
          return reply
            .status(400)
            .send({ error: "marketId and hash must be 32 bytes (64 hex chars)" });
        }

        // Validate that the market's round hasn't ended (anti-cheat)
        if (!epochManager.isMarketCommittable(marketId)) {
          return reply
            .status(400)
            .send({ error: "Market round has ended — cannot commit after resolution" });
        }

        const transaction = await solana.buildCommitTx(minerPubkey, marketIdBuf, hashBuf);

        return { transaction };
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ error: "Failed to build commit transaction" });
      }
    }
  );

  // POST /v1/submit-reveal — Get unsigned reveal transaction
  app.post<{
    Body: {
      miner: string;
      epochId: number;
      marketId: string; // hex
      salt: string; // hex
      prediction: number; // 1=NO, 2=YES
    };
  }>(
    "/v1/submit-reveal",
    { preHandler: authHook(authService) },
    async (request, reply) => {
      const { miner, epochId, marketId, salt, prediction } = request.body || {};
      if (!miner || !epochId || !marketId || !salt || !prediction) {
        return reply.status(400).send({ error: "Missing required fields" });
      }

      if (prediction !== 1 && prediction !== 2) {
        return reply
          .status(400)
          .send({ error: "prediction must be 1 (NO) or 2 (YES)" });
      }

      try {
        const minerPubkey = new PublicKey(miner);
        const marketIdBuf = Buffer.from(marketId, "hex");
        const saltBuf = Buffer.from(salt, "hex");

        if (marketIdBuf.length !== 32 || saltBuf.length !== 32) {
          return reply
            .status(400)
            .send({ error: "marketId and salt must be 32 bytes (64 hex chars)" });
        }

        const transaction = await solana.buildRevealTx(
          minerPubkey,
          epochId,
          marketIdBuf,
          saltBuf,
          prediction
        );

        return { transaction };
      } catch (err: any) {
        request.log.error(err);
        const detail = err?.message || String(err);
        return reply.status(500).send({
          error: "Failed to build reveal transaction",
          detail: detail.slice(0, 500),
        });
      }
    }
  );

  // POST /v1/submit-stake — Get unsigned stake transaction
  app.post<{
    Body: { miner: string; amount: string; minerTokenAccount: string };
  }>(
    "/v1/submit-stake",
    { preHandler: authHook(authService) },
    async (request, reply) => {
      const { miner, amount, minerTokenAccount } = request.body || {};
      if (!miner || !amount || !minerTokenAccount) {
        return reply.status(400).send({ error: "Missing required fields" });
      }

      try {
        const transaction = await solana.buildStakeTx(
          new PublicKey(miner),
          BigInt(amount),
          new PublicKey(minerTokenAccount)
        );
        return { transaction };
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ error: "Failed to build stake transaction" });
      }
    }
  );

  // POST /v1/submit-unstake — Get unsigned unstake transaction
  app.post<{
    Body: { miner: string };
  }>(
    "/v1/submit-unstake",
    { preHandler: authHook(authService) },
    async (request, reply) => {
      const { miner } = request.body || {};
      if (!miner) {
        return reply.status(400).send({ error: "Missing 'miner'" });
      }

      try {
        const transaction = await solana.buildUnstakeTx(new PublicKey(miner));
        return { transaction };
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ error: "Failed to build unstake transaction" });
      }
    }
  );

  // POST /v1/submit-withdraw — Get unsigned withdraw transaction
  app.post<{
    Body: { miner: string; minerTokenAccount: string };
  }>(
    "/v1/submit-withdraw",
    { preHandler: authHook(authService) },
    async (request, reply) => {
      const { miner, minerTokenAccount } = request.body || {};
      if (!miner || !minerTokenAccount) {
        return reply.status(400).send({ error: "Missing required fields" });
      }

      try {
        const transaction = await solana.buildWithdrawTx(
          new PublicKey(miner),
          new PublicKey(minerTokenAccount)
        );
        return { transaction };
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ error: "Failed to build withdraw transaction" });
      }
    }
  );
}
