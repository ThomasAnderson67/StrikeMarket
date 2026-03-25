#!/usr/bin/env npx tsx
/**
 * Devnet reinitialization script for Strike.
 *
 * Calls the `initialize` instruction with continuous-mining parameters
 * (overlapping commit/reveal windows) so miners can commit and reveal
 * at any point during the epoch.
 *
 * Epoch duration is 600s (10 minutes) for fast devnet iteration.
 * In production this would be 86400s (24 hours).
 *
 * Usage:
 *   npx tsx scripts/reinit-devnet.ts
 *
 * Requires:
 *   - Program deployed to devnet (2BewLeJcdz8cmdjo1WvhtNphFoc7wk9V6fXUk5vzb19Q)
 *   - $STRK mint on devnet (DtGRMG6Qw47Rqm6bQ6aY32TPv6Q9rUaSBzZezHpM3sHk)
 *   - Admin wallet at ~/.config/solana/id.json with SOL
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import fs from "fs";

// ── Config ──────────────────────────────────────────────────────────

const RPC_URL = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("44aVv3wfjoCsUbcRNym8CQuTLtRW36Msq4DWEnZzYmSg");
const STRK_MINT = new PublicKey("DtGRMG6Qw47Rqm6bQ6aY32TPv6Q9rUaSBzZezHpM3sHk");

// Continuous-mining epoch timing for devnet testing.
// epoch_duration = 600s (10 min). Production would be 86400s (24h).
// Commit and reveal windows span the entire epoch so miners can
// participate at any point — no gap between phases.
const EPOCH_DURATION = 1800;          // 10 minutes (production: 86400 = 24h)
const COMMIT_END_OFFSET = 1800;      // commit open for entire epoch
const REVEAL_START_OFFSET = 0;      // reveal opens at epoch start
const REVEAL_END_OFFSET = 1800;      // reveal open for entire epoch
const MARKET_COUNT = 7;             // 7 crypto tokens

// ── Helpers ─────────────────────────────────────────────────────────

function loadKeypair(path: string): Keypair {
  const resolved = path.replace("~", process.env.HOME || "");
  const data = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(data));
}

function findPDA(seeds: (Buffer | Uint8Array)[]): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
}

function epochIdBuf(id: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(id));
  return buf;
}

function ok(msg: string) {
  console.log(`  ✅ ${msg}`);
}

function info(msg: string) {
  console.log(`  ℹ️  ${msg}`);
}

function step(msg: string) {
  console.log(`\n▶ ${msg}`);
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Strike Devnet Reinitialization");
  console.log("═══════════════════════════════════════════════════════");

  const connection = new Connection(RPC_URL, "confirmed");
  const admin = loadKeypair("~/.config/solana/id.json");
  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });

  // Load IDL from the built program
  const idlPath = new URL("../../strike-program/target/idl/enelbot.json", import.meta.url); // IDL path matches Anchor's output dir (program module is still named "enelbot")
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider);

  console.log(`\nAdmin:    ${admin.publicKey.toBase58()}`);
  console.log(`Program:  ${PROGRAM_ID.toBase58()}`);
  console.log(`Mint:     ${STRK_MINT.toBase58()}`);

  // PDAs
  const [globalState] = findPDA([Buffer.from("global")]);
  const [vault] = findPDA([Buffer.from("vault")]);
  const [epochState1] = findPDA([Buffer.from("epoch"), epochIdBuf(1)]);

  console.log(`\nGlobalState PDA: ${globalState.toBase58()}`);
  console.log(`Vault PDA:       ${vault.toBase58()}`);
  console.log(`Epoch 1 PDA:     ${epochState1.toBase58()}`);

  // ── Initialize ──────────────────────────────────────────────────

  step("Initialize program (GlobalState + Epoch 1)");
  console.log(`  Parameters:`);
  console.log(`    epoch_duration:      ${EPOCH_DURATION}s (${EPOCH_DURATION / 60} min)`);
  console.log(`    commit_end_offset:   ${COMMIT_END_OFFSET}s (commit open entire epoch)`);
  console.log(`    reveal_start_offset: ${REVEAL_START_OFFSET}s (reveal opens at start)`);
  console.log(`    reveal_end_offset:   ${REVEAL_END_OFFSET}s (reveal open entire epoch)`);
  console.log(`    market_count:        ${MARKET_COUNT}`);

  try {
    const sig = await program.methods
      .initialize({
        epochDuration: new BN(EPOCH_DURATION),
        commitEndOffset: new BN(COMMIT_END_OFFSET),
        revealStartOffset: new BN(REVEAL_START_OFFSET),
        revealEndOffset: new BN(REVEAL_END_OFFSET),
        marketCount: MARKET_COUNT,
      })
      .accounts({
        globalState,
        epochState: epochState1,
        vault,
        enelMint: STRK_MINT,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    ok("Program initialized, epoch 1 started");
    console.log(`  TX: ${sig}`);
  } catch (err: any) {
    if (err.toString().includes("already in use")) {
      info("Already initialized — reading existing state");
    } else {
      throw err;
    }
  }

  // ── Print GlobalState ───────────────────────────────────────────

  step("GlobalState");
  const gs = await (program.account as any).globalState.fetch(globalState);
  const currentEpochId = gs.currentEpoch.toNumber();
  console.log(`  admin:              ${gs.admin.toBase58()}`);
  console.log(`  enel_mint:          ${gs.enelMint.toBase58()}`);
  console.log(`  current_epoch:      ${currentEpochId}`);
  console.log(`  epoch_duration:     ${gs.epochDuration.toNumber()}s`);
  console.log(`  commit_end_offset:  ${gs.commitEndOffset.toNumber()}s`);
  console.log(`  reveal_start_offset:${gs.revealStartOffset.toNumber()}s`);
  console.log(`  reveal_end_offset:  ${gs.revealEndOffset.toNumber()}s`);
  console.log(`  market_count:       ${gs.marketCount}`);

  // ── Print EpochState ────────────────────────────────────────────

  step("EpochState (current)");
  const [currentEpochPDA] = findPDA([Buffer.from("epoch"), epochIdBuf(currentEpochId)]);
  const es = await (program.account as any).epochState.fetch(currentEpochPDA);
  const epochStart = es.epochStart.toNumber();
  const now = Math.floor(Date.now() / 1000);
  const elapsed = now - epochStart;
  const remaining = Math.max(0, gs.epochDuration.toNumber() - elapsed);

  console.log(`  epoch_id:       ${es.epochId.toNumber()}`);
  console.log(`  epoch_start:    ${epochStart} (${new Date(epochStart * 1000).toISOString()})`);
  console.log(`  elapsed:        ${elapsed}s`);
  console.log(`  remaining:      ${remaining}s`);
  console.log(`  total_credits:  ${es.totalCredits.toNumber()}`);
  console.log(`  reward_amount:  ${es.rewardAmount.toNumber()}`);
  console.log(`  claimed_amount: ${es.claimedAmount.toNumber()}`);

  // ── Summary ─────────────────────────────────────────────────────

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  ✅ Devnet reinitialization complete");
  console.log("═══════════════════════════════════════════════════════");
  console.log();
}

main().catch((err) => {
  console.error("\n❌ REINIT FAILED:", err);
  process.exit(1);
});
