import { PublicKey, Keypair, Connection } from "@solana/web3.js";
import fs from "fs";

// ── Program constants (must match programs/enelbot/src/state.rs) ────────
export const TOKEN_DECIMALS = 6;
export const TIER_1_MINIMUM = 1_000_000n * 10n ** BigInt(TOKEN_DECIMALS);
export const TIER_2_MINIMUM = 10_000_000n * 10n ** BigInt(TOKEN_DECIMALS);
export const TIER_3_MINIMUM = 100_000_000n * 10n ** BigInt(TOKEN_DECIMALS);
export const MAX_TIER_MULTIPLIER = 3;

export function calculateTier(stakedAmount: bigint): number {
  if (stakedAmount >= TIER_3_MINIMUM) return 3;
  if (stakedAmount >= TIER_2_MINIMUM) return 2;
  if (stakedAmount >= TIER_1_MINIMUM) return 1;
  return 0;
}

export function tierMultiplier(tier: number): number {
  if (tier >= 1 && tier <= 3) return tier;
  return 0;
}

const DEV_JWT_SECRET = "enelbot-dev-secret-change-in-production";

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET env var is required in production");
  }
  if (secret) return secret;
  console.warn("[config] WARNING: Using default JWT secret. Set JWT_SECRET in production.");
  return DEV_JWT_SECRET;
}

// ── Environment config ─────────────────────────────────────────────────

export interface Config {
  port: number;
  host: string;
  rpcUrl: string;
  programId: PublicKey;
  enelMint: PublicKey;
  adminKeypair: Keypair;
  adminTokenAccount: PublicKey;
  jwtSecret: string;
  jwtExpirySeconds: number;
  epochRewardAmount: bigint;
}

export function loadConfig(): Config {
  // Support keypair via env var (Railway/Docker) or file path (local dev)
  let adminKeypair: Keypair;
  if (process.env.ADMIN_KEYPAIR_JSON) {
    const keyData = JSON.parse(process.env.ADMIN_KEYPAIR_JSON);
    adminKeypair = Keypair.fromSecretKey(Uint8Array.from(keyData));
  } else {
    const adminKeyPath = process.env.ADMIN_KEYPAIR_PATH || "~/.config/solana/id.json";
    const resolvedPath = adminKeyPath.replace("~", process.env.HOME || "");
    const adminKeyData = JSON.parse(fs.readFileSync(resolvedPath, "utf-8"));
    adminKeypair = Keypair.fromSecretKey(Uint8Array.from(adminKeyData));
  }

  return {
    port: parseInt(process.env.PORT || "3000"),
    host: process.env.HOST || "0.0.0.0",
    rpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    programId: new PublicKey(
      process.env.PROGRAM_ID || "2BewLeJcdz8cmdjo1WvhtNphFoc7wk9V6fXUk5vzb19Q"
    ),
    enelMint: new PublicKey(process.env.ENEL_MINT || "DtGRMG6Qw47Rqm6bQ6aY32TPv6Q9rUaSBzZezHpM3sHk"),
    adminKeypair,
    adminTokenAccount: new PublicKey(
      process.env.ADMIN_TOKEN_ACCOUNT || "CAuWzHjPSChSkyqw3KNK6h3oxPSYDPJJtDWC8yvVYWK6"
    ),
    jwtSecret: getJwtSecret(),
    jwtExpirySeconds: parseInt(process.env.JWT_EXPIRY_SECONDS || "3600"),
    epochRewardAmount: BigInt(process.env.EPOCH_REWARD_AMOUNT || "1000000000000"), // 1M ENEL default
  };
}
