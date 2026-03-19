import { FastifyRequest, FastifyReply } from "fastify";
import { PublicKey } from "@solana/web3.js";
import jwt from "jsonwebtoken";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { randomBytes } from "crypto";
import { Config } from "../config.js";
import { SolanaService } from "../services/solana.js";

// ── Auth service ───────────────────────────────────────────────────────
//
// Authentication flow:
//   1. Agent requests nonce: POST /v1/auth/nonce { miner }
//   2. Agent signs nonce with Solana wallet (ed25519)
//   3. Agent verifies:  POST /v1/auth/verify { miner, message, signature }
//   4. Coordinator returns JWT token
//
// Nonce replay protection:
//   - Used nonces tracked in Set with TTL
//   - Each nonce valid for one verification only
//   - Nonces expire after JWT expiry + buffer

export class AuthService {
  private config: Config;
  private solana: SolanaService;

  /** Pending nonces: nonce → { miner, createdAt } */
  private pendingNonces = new Map<string, { miner: string; createdAt: number }>();

  /** Used nonces (replay protection): nonce → expiry timestamp */
  private usedNonces = new Map<string, number>();

  /** Cleanup interval */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Config, solana: SolanaService) {
    this.config = config;
    this.solana = solana;

    // Periodically clean expired nonces
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60_000);
  }

  stop() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  /**
   * Generate a nonce message for signing.
   */
  generateNonce(minerPubkey: string): { message: string; nonce: string } {
    const nonce = randomBytes(32).toString("hex");
    const message = `Strike auth nonce: ${nonce}\nMiner: ${minerPubkey}\nTimestamp: ${Date.now()}`;

    this.pendingNonces.set(nonce, {
      miner: minerPubkey,
      createdAt: Date.now(),
    });

    // Nonces expire after 5 minutes if not verified
    setTimeout(() => this.pendingNonces.delete(nonce), 5 * 60 * 1000);

    return { message, nonce };
  }

  /**
   * Verify a signed nonce and return a JWT.
   */
  async verify(
    minerPubkey: string,
    message: string,
    signature: string
  ): Promise<{ token: string; expiresAt: number }> {
    // Extract nonce from message
    const nonceMatch = message.match(/Strike auth nonce: ([a-f0-9]+)/);
    if (!nonceMatch) {
      throw new AuthError(401, "Invalid message format");
    }
    const nonce = nonceMatch[1];

    // Check nonce was issued and not used
    const pending = this.pendingNonces.get(nonce);
    if (!pending) {
      throw new AuthError(401, "Unknown or expired nonce");
    }
    if (pending.miner !== minerPubkey) {
      throw new AuthError(401, "Nonce miner mismatch");
    }

    // Replay protection: check not already used
    if (this.usedNonces.has(nonce)) {
      throw new AuthError(401, "Nonce already used");
    }

    // Verify ed25519 signature
    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(minerPubkey);
    } catch {
      throw new AuthError(400, "Invalid miner public key");
    }

    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.decode(signature);

    const valid = nacl.sign.detached.verify(
      messageBytes,
      signatureBytes,
      pubkey.toBytes()
    );
    if (!valid) {
      throw new AuthError(401, "Invalid signature");
    }

    // Check miner is staked (tier >= 1)
    const minerState = await this.solana.getMinerState(pubkey);
    if (!minerState || (minerState as any).tier < 1) {
      throw new AuthError(403, "Insufficient stake. Minimum tier 1 required.");
    }

    // Mark nonce as used
    this.pendingNonces.delete(nonce);
    const expiry = Date.now() + (this.config.jwtExpirySeconds + 300) * 1000;
    this.usedNonces.set(nonce, expiry);

    // Generate JWT
    const expiresAt = Math.floor(Date.now() / 1000) + this.config.jwtExpirySeconds;
    const token = jwt.sign(
      {
        miner: minerPubkey,
        tier: (minerState as any).tier,
      },
      this.config.jwtSecret,
      { expiresIn: this.config.jwtExpirySeconds }
    );

    return { token, expiresAt };
  }

  /**
   * Verify a JWT token and return the miner info.
   */
  verifyToken(token: string): { miner: string; tier: number } {
    try {
      const payload = jwt.verify(token, this.config.jwtSecret) as any;
      return { miner: payload.miner, tier: payload.tier };
    } catch {
      throw new AuthError(401, "Invalid or expired token");
    }
  }

  private cleanupExpired() {
    const now = Date.now();
    for (const [nonce, expiry] of this.usedNonces) {
      if (expiry < now) {
        this.usedNonces.delete(nonce);
      }
    }
  }
}

export class AuthError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message);
  }
}

// ── Fastify auth hook ──────────────────────────────────────────────────

export function authHook(authService: AuthService) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Missing authorization header" });
    }
    const token = authHeader.slice(7);
    try {
      const payload = authService.verifyToken(token);
      (request as any).miner = payload.miner;
      (request as any).tier = payload.tier;
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.status(err.statusCode).send({ error: err.message });
      }
      return reply.status(401).send({ error: "Authentication failed" });
    }
  };
}
