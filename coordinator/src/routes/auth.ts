import { FastifyInstance } from "fastify";
import { AuthService, AuthError } from "../middleware/auth.js";

const AUTH_RATE_LIMIT = {
  config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
};

export function registerAuthRoutes(app: FastifyInstance, authService: AuthService) {
  // POST /v1/auth/nonce — Request a signing nonce
  app.post<{
    Body: { miner: string };
  }>("/v1/auth/nonce", AUTH_RATE_LIMIT, async (request, reply) => {
    const { miner } = request.body || {};
    if (!miner) {
      return reply.status(400).send({ error: "Missing 'miner' field" });
    }

    try {
      const { message, nonce } = authService.generateNonce(miner);
      return { message, nonce };
    } catch (err) {
      return reply.status(500).send({ error: "Failed to generate nonce" });
    }
  });

  // POST /v1/auth/verify — Verify signature and get JWT
  app.post<{
    Body: { miner: string; message: string; signature: string };
  }>("/v1/auth/verify", AUTH_RATE_LIMIT, async (request, reply) => {
    const { miner, message, signature } = request.body || {};
    if (!miner || !message || !signature) {
      return reply
        .status(400)
        .send({ error: "Missing 'miner', 'message', or 'signature' field" });
    }

    try {
      const result = await authService.verify(miner, message, signature);
      return result;
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.status(err.statusCode).send({ error: err.message });
      }
      return reply.status(500).send({ error: "Verification failed" });
    }
  });
}
