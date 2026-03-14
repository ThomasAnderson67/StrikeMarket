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
  const adminKeyPath = process.env.ADMIN_KEYPAIR_PATH || "~/.config/solana/id.json";
  const resolvedPath = adminKeyPath.replace("~", process.env.HOME || "");
  const adminKeyData = JSON.parse(fs.readFileSync(resolvedPath, "utf-8"));
  const adminKeypair = Keypair.fromSecretKey(Uint8Array.from(adminKeyData));

  return {
    port: parseInt(process.env.PORT || "3000"),
    host: process.env.HOST || "0.0.0.0",
    rpcUrl: process.env.SOLANA_RPC_URL || "http://localhost:8899",
    programId: new PublicKey(
      process.env.PROGRAM_ID || "2BewLeJcdz8cmdjo1WvhtNphFoc7wk9V6fXUk5vzb19Q"
    ),
    enelMint: new PublicKey(process.env.ENEL_MINT || PublicKey.default.toBase58()),
    adminKeypair,
    adminTokenAccount: new PublicKey(
      process.env.ADMIN_TOKEN_ACCOUNT || PublicKey.default.toBase58()
    ),
    jwtSecret: process.env.JWT_SECRET || "enelbot-dev-secret-change-in-production",
    jwtExpirySeconds: parseInt(process.env.JWT_EXPIRY_SECONDS || "3600"),
    epochRewardAmount: BigInt(process.env.EPOCH_REWARD_AMOUNT || "1000000000000"), // 1M ENEL default
  };
}
