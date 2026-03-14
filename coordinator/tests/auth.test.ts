import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import jwt from "jsonwebtoken";
import { AuthService, AuthError } from "../src/middleware/auth.js";
import type { Config } from "../src/config.js";
import type { SolanaService } from "../src/services/solana.js";

// ── Mock SolanaService ─────────────────────────────────────────────────

function makeMockSolana(tier: number = 1): SolanaService {
  return {
    getMinerState: vi.fn().mockResolvedValue({ tier }),
  } as any;
}

function makeConfig(): Config {
  return {
    jwtSecret: "test-secret-for-unit-tests",
    jwtExpirySeconds: 3600,
    adminKeypair: Keypair.generate(),
  } as any;
}

// ── Helpers ──────────────────────────────────────────────────────────

function signMessage(keypair: Keypair, message: string): string {
  const messageBytes = new TextEncoder().encode(message);
  const signature = nacl.sign.detached(messageBytes, keypair.secretKey);
  return bs58.encode(signature);
}

// ── Tests ────────────────────────────────────────────────────────────

describe("AuthService", () => {
  let authService: AuthService;
  let config: Config;
  let solana: SolanaService;

  beforeEach(() => {
    config = makeConfig();
    solana = makeMockSolana(1);
    authService = new AuthService(config, solana);
  });

  afterEach(() => {
    authService.stop();
  });

  describe("generateNonce", () => {
    it("returns a message containing the nonce and miner", () => {
      const miner = Keypair.generate().publicKey.toBase58();
      const { message, nonce } = authService.generateNonce(miner);

      expect(message).toContain(`ENELBOT auth nonce: ${nonce}`);
      expect(message).toContain(`Miner: ${miner}`);
      expect(nonce).toMatch(/^[a-f0-9]{64}$/); // 32 bytes hex
    });

    it("generates unique nonces", () => {
      const miner = Keypair.generate().publicKey.toBase58();
      const { nonce: n1 } = authService.generateNonce(miner);
      const { nonce: n2 } = authService.generateNonce(miner);
      expect(n1).not.toBe(n2);
    });
  });

  describe("verify", () => {
    it("returns JWT for valid nonce + signature", async () => {
      const keypair = Keypair.generate();
      const miner = keypair.publicKey.toBase58();

      const { message } = authService.generateNonce(miner);
      const signature = signMessage(keypair, message);

      const result = await authService.verify(miner, message, signature);

      expect(result.token).toBeTruthy();
      expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

      // Verify JWT contents
      const payload = jwt.verify(result.token, config.jwtSecret) as any;
      expect(payload.miner).toBe(miner);
      expect(payload.tier).toBe(1);
    });

    it("rejects unknown nonce", async () => {
      const keypair = Keypair.generate();
      const miner = keypair.publicKey.toBase58();
      const fakeMessage = `ENELBOT auth nonce: ${"a".repeat(64)}\nMiner: ${miner}\nTimestamp: ${Date.now()}`;
      const signature = signMessage(keypair, fakeMessage);

      await expect(authService.verify(miner, fakeMessage, signature)).rejects.toThrow(
        "Unknown or expired nonce"
      );
    });

    it("rejects invalid message format", async () => {
      const keypair = Keypair.generate();
      const miner = keypair.publicKey.toBase58();
      const badMessage = "not a valid auth message";
      const signature = signMessage(keypair, badMessage);

      await expect(authService.verify(miner, badMessage, signature)).rejects.toThrow(
        "Invalid message format"
      );
    });

    it("rejects nonce miner mismatch", async () => {
      const keypair1 = Keypair.generate();
      const keypair2 = Keypair.generate();
      const miner1 = keypair1.publicKey.toBase58();
      const miner2 = keypair2.publicKey.toBase58();

      const { message } = authService.generateNonce(miner1);
      const signature = signMessage(keypair2, message);

      await expect(authService.verify(miner2, message, signature)).rejects.toThrow(
        "Nonce miner mismatch"
      );
    });

    it("rejects invalid signature", async () => {
      const keypair = Keypair.generate();
      const wrongKeypair = Keypair.generate();
      const miner = keypair.publicKey.toBase58();

      const { message } = authService.generateNonce(miner);
      // Sign with wrong key
      const badSignature = signMessage(wrongKeypair, message);

      await expect(authService.verify(miner, message, badSignature)).rejects.toThrow(
        "Invalid signature"
      );
    });

    it("rejects nonce replay (same nonce used twice)", async () => {
      const keypair = Keypair.generate();
      const miner = keypair.publicKey.toBase58();

      const { message } = authService.generateNonce(miner);
      const signature = signMessage(keypair, message);

      // First use succeeds
      await authService.verify(miner, message, signature);

      // Second use fails (replay)
      await expect(authService.verify(miner, message, signature)).rejects.toThrow(
        /already used|Unknown/
      );
    });

    it("rejects unstaked miner (tier 0)", async () => {
      const unstakedSolana = makeMockSolana(0);
      const unstakedAuth = new AuthService(config, unstakedSolana);

      const keypair = Keypair.generate();
      const miner = keypair.publicKey.toBase58();

      const { message } = unstakedAuth.generateNonce(miner);
      const signature = signMessage(keypair, message);

      await expect(unstakedAuth.verify(miner, message, signature)).rejects.toThrow(
        "Insufficient stake"
      );

      unstakedAuth.stop();
    });

    it("rejects miner with no MinerState account", async () => {
      const noStateSolana = { getMinerState: vi.fn().mockResolvedValue(null) } as any;
      const auth = new AuthService(config, noStateSolana);

      const keypair = Keypair.generate();
      const miner = keypair.publicKey.toBase58();

      const { message } = auth.generateNonce(miner);
      const signature = signMessage(keypair, message);

      await expect(auth.verify(miner, message, signature)).rejects.toThrow(
        "Insufficient stake"
      );

      auth.stop();
    });
  });

  describe("verifyToken", () => {
    it("returns miner and tier from valid JWT", async () => {
      const keypair = Keypair.generate();
      const miner = keypair.publicKey.toBase58();

      const { message } = authService.generateNonce(miner);
      const signature = signMessage(keypair, message);
      const { token } = await authService.verify(miner, message, signature);

      const payload = authService.verifyToken(token);
      expect(payload.miner).toBe(miner);
      expect(payload.tier).toBe(1);
    });

    it("rejects expired JWT", () => {
      const token = jwt.sign(
        { miner: "test", tier: 1 },
        config.jwtSecret,
        { expiresIn: -1 } // Already expired
      );

      expect(() => authService.verifyToken(token)).toThrow("Invalid or expired token");
    });

    it("rejects JWT signed with wrong secret", () => {
      const token = jwt.sign(
        { miner: "test", tier: 1 },
        "wrong-secret",
        { expiresIn: 3600 }
      );

      expect(() => authService.verifyToken(token)).toThrow("Invalid or expired token");
    });

    it("rejects malformed JWT", () => {
      expect(() => authService.verifyToken("not-a-jwt")).toThrow(
        "Invalid or expired token"
      );
    });
  });

  describe("tier handling in JWT", () => {
    it("includes tier 3 in JWT for whale staker", async () => {
      const whaleSolana = makeMockSolana(3);
      const whaleAuth = new AuthService(config, whaleSolana);

      const keypair = Keypair.generate();
      const miner = keypair.publicKey.toBase58();

      const { message } = whaleAuth.generateNonce(miner);
      const signature = signMessage(keypair, message);
      const { token } = await whaleAuth.verify(miner, message, signature);

      const payload = whaleAuth.verifyToken(token);
      expect(payload.tier).toBe(3);

      whaleAuth.stop();
    });
  });
});
