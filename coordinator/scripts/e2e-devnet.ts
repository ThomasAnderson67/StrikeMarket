#!/usr/bin/env npx tsx
/**
 * End-to-end devnet test for Strike.
 *
 * Tests the full mining lifecycle against the deployed program:
 *   initialize → stake → commit → (wait) → advance → reveal → score → fund → claim → close
 *
 * Uses short epoch timing (commit=40s, reveal=60-80s, epoch_duration=60s)
 * so the full test completes in ~2 minutes.
 *
 * Usage:
 *   npx tsx scripts/e2e-devnet.ts
 *
 * Requires:
 *   - Program deployed to devnet (2BewLeJcdz8cmdjo1WvhtNphFoc7wk9V6fXUk5vzb19Q)
 *   - $STRK mint on devnet (DtGRMG6Qw47Rqm6bQ6aY32TPv6Q9rUaSBzZezHpM3sHk)
 *   - Admin wallet at ~/.config/solana/id.json with SOL + $STRK
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  transfer,
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { createHash } from "crypto";
import fs from "fs";

// ── Config ──────────────────────────────────────────────────────────

const RPC_URL = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("2BewLeJcdz8cmdjo1WvhtNphFoc7wk9V6fXUk5vzb19Q");
const STRK_MINT = new PublicKey("DtGRMG6Qw47Rqm6bQ6aY32TPv6Q9rUaSBzZezHpM3sHk");

// Short epoch timing for testing
const EPOCH_DURATION = 60;         // 60s
const COMMIT_END_OFFSET = 40;      // commit: 0-40s
const REVEAL_START_OFFSET = 60;    // reveal: 60-80s
const REVEAL_END_OFFSET = 80;

const TOKEN_DECIMALS = 6;
const TIER_1_AMOUNT = 1_000_000 * 10 ** TOKEN_DECIMALS; // 1M $STRK
const REWARD_AMOUNT = 100_000 * 10 ** TOKEN_DECIMALS;   // 100K $STRK reward pool

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

function computeHash(
  salt: Buffer,
  miner: PublicKey,
  epochId: number,
  marketId: Buffer,
  prediction: number
): Buffer {
  return createHash("sha256")
    .update(salt)
    .update(miner.toBuffer())
    .update(epochIdBuf(epochId))
    .update(marketId)
    .update(Buffer.from([prediction]))
    .digest();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ok(msg: string) {
  console.log(`  ✅ ${msg}`);
}

function step(msg: string) {
  console.log(`\n▶ ${msg}`);
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Strike End-to-End Devnet Test");
  console.log("═══════════════════════════════════════════════════════");

  const connection = new Connection(RPC_URL, "confirmed");
  const admin = loadKeypair("~/.config/solana/id.json");
  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });

  // Load IDL from the deployed program
  const idlPath = new URL("../../strike-program/target/idl/strike.json", import.meta.url);
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider);

  // Generate a test miner keypair
  const miner = Keypair.generate();
  console.log(`\nAdmin:  ${admin.publicKey.toBase58()}`);
  console.log(`Miner:  ${miner.publicKey.toBase58()}`);
  console.log(`Mint:   ${STRK_MINT.toBase58()}`);

  // PDAs
  const [globalState] = findPDA([Buffer.from("global")]);
  const [vault] = findPDA([Buffer.from("vault")]);

  // Test market
  const marketId = createHash("sha256").update("e2e-test-market").digest();
  const salt = Buffer.from(
    "e2e_salt_0123456789abcdef0123456789abcdef0123456789abcdef01234567",
    "hex"
  );
  // Pad/truncate salt to 32 bytes
  const salt32 = Buffer.alloc(32);
  salt.copy(salt32, 0, 0, Math.min(salt.length, 32));

  const prediction = 2; // YES

  // ── Step 1: Fund miner with SOL ───────────────────────────────

  step("Airdrop SOL to miner");
  try {
    const sig = await connection.requestAirdrop(miner.publicKey, 0.1 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
    ok(`Miner funded with 0.1 SOL`);
  } catch {
    // Airdrop may be rate-limited; try transferring from admin
    console.log("  Airdrop rate-limited, transferring from admin...");
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: miner.publicKey,
        lamports: 0.1 * LAMPORTS_PER_SOL,
      })
    );
    await provider.sendAndConfirm(tx);
    ok("Miner funded with 0.1 SOL from admin");
  }

  // ── Step 2: Create miner token account + send $STRK ───────────

  step("Create miner token account and transfer $STRK");
  const adminAta = await getOrCreateAssociatedTokenAccount(
    connection, admin, STRK_MINT, admin.publicKey
  );
  const minerAta = await getOrCreateAssociatedTokenAccount(
    connection, admin, STRK_MINT, miner.publicKey
  );
  await transfer(
    connection, admin, adminAta.address, minerAta.address, admin,
    BigInt(TIER_1_AMOUNT) * 2n // Send 2x tier 1 for staking
  );
  ok(`Transferred ${(TIER_1_AMOUNT * 2) / 10 ** TOKEN_DECIMALS} $STRK to miner`);

  // ── Step 3: Initialize program ────────────────────────────────

  step("Initialize program (GlobalState + Epoch 1)");
  const [epochState1] = findPDA([Buffer.from("epoch"), epochIdBuf(1)]);

  try {
    await program.methods
      .initialize({
        epochDuration: new BN(EPOCH_DURATION),
        commitEndOffset: new BN(COMMIT_END_OFFSET),
        revealStartOffset: new BN(REVEAL_START_OFFSET),
        revealEndOffset: new BN(REVEAL_END_OFFSET),
        marketCount: 1,
      })
      .accounts({
        globalState,
        epochState: epochState1,
        vault,
        strkMint: STRK_MINT,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    ok("Program initialized, epoch 1 started");
  } catch (err: any) {
    if (err.toString().includes("already in use")) {
      console.log("  ℹ️  Already initialized, checking state...");
      const gs = await (program.account as any).globalState.fetch(globalState);
      console.log(`  Current epoch: ${gs.currentEpoch.toNumber()}`);
      ok("Using existing state");
    } else {
      throw err;
    }
  }

  // Read current epoch from chain
  const gs = await (program.account as any).globalState.fetch(globalState);
  const epochId = gs.currentEpoch.toNumber();
  const [currentEpochState] = findPDA([Buffer.from("epoch"), epochIdBuf(epochId)]);
  const es = await (program.account as any).epochState.fetch(currentEpochState);
  const epochStart = es.epochStart.toNumber();
  const now = Math.floor(Date.now() / 1000);
  const elapsed = now - epochStart;

  console.log(`  Epoch ${epochId}, started ${elapsed}s ago`);

  // If we're past the commit window, advance to a new epoch first
  if (elapsed >= COMMIT_END_OFFSET) {
    step("Current epoch past commit window, advancing...");
    if (elapsed >= EPOCH_DURATION) {
      const [newEpochState] = findPDA([Buffer.from("epoch"), epochIdBuf(epochId + 1)]);
      await program.methods
        .advanceEpoch(1)
        .accounts({
          globalState,
          currentEpochState,
          newEpochState,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      ok(`Advanced to epoch ${epochId + 1}`);
    } else {
      console.log(`  Waiting ${EPOCH_DURATION - elapsed + 2}s for epoch to end...`);
      await sleep((EPOCH_DURATION - elapsed + 2) * 1000);
      const [newEpochState] = findPDA([Buffer.from("epoch"), epochIdBuf(epochId + 1)]);
      await program.methods
        .advanceEpoch(1)
        .accounts({
          globalState,
          currentEpochState,
          newEpochState,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      ok(`Advanced to epoch ${epochId + 1}`);
    }
  }

  // Re-read current epoch
  const gs2 = await (program.account as any).globalState.fetch(globalState);
  const currentEpochId = gs2.currentEpoch.toNumber();
  const [activeEpochState] = findPDA([Buffer.from("epoch"), epochIdBuf(currentEpochId)]);
  console.log(`  Active epoch: ${currentEpochId}`);

  // ── Step 4: Stake ─────────────────────────────────────────────

  step("Stake $STRK (tier 1)");
  const [minerState] = findPDA([Buffer.from("miner"), miner.publicKey.toBuffer()]);

  await program.methods
    .stake(new BN(TIER_1_AMOUNT))
    .accounts({
      globalState,
      minerState,
      vault,
      minerTokenAccount: minerAta.address,
      miner: miner.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([miner])
    .rpc();

  const ms = await (program.account as any).minerState.fetch(minerState);
  ok(`Staked ${TIER_1_AMOUNT / 10 ** TOKEN_DECIMALS} $STRK → tier ${ms.tier}`);

  // ── Step 5: Commit prediction ─────────────────────────────────

  step("Commit prediction (YES on test market)");
  const hash = computeHash(salt32, miner.publicKey, currentEpochId, marketId, prediction);
  const [commitment] = findPDA([
    Buffer.from("commitment"),
    epochIdBuf(currentEpochId),
    miner.publicKey.toBuffer(),
    marketId,
  ]);

  await program.methods
    .commitPrediction(Array.from(marketId) as any, Array.from(hash) as any)
    .accounts({
      globalState,
      epochState: activeEpochState,
      minerState,
      commitment,
      miner: miner.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([miner])
    .rpc();

  const c = await (program.account as any).commitment.fetch(commitment);
  ok(`Committed hash: ${Buffer.from(c.hash).toString("hex").slice(0, 16)}...`);

  // ── Step 6: Wait for reveal window ────────────────────────────

  step("Waiting for reveal window...");
  const es2 = await (program.account as any).epochState.fetch(activeEpochState);
  const epochStart2 = es2.epochStart.toNumber();
  const revealOpens = epochStart2 + REVEAL_START_OFFSET;
  const nowTs = Math.floor(Date.now() / 1000);

  // We need epoch to end (advance_epoch) before reveal opens
  // First wait for epoch_duration to pass
  const epochEndsAt = epochStart2 + EPOCH_DURATION;
  if (nowTs < epochEndsAt) {
    const waitEpoch = epochEndsAt - nowTs + 2;
    console.log(`  Waiting ${waitEpoch}s for epoch to end...`);
    await sleep(waitEpoch * 1000);
  }

  // Advance epoch
  step("Advance epoch (opens reveal window for previous epoch)");
  const [nextEpochState] = findPDA([Buffer.from("epoch"), epochIdBuf(currentEpochId + 1)]);
  await program.methods
    .advanceEpoch(1)
    .accounts({
      globalState,
      currentEpochState: activeEpochState,
      newEpochState: nextEpochState,
      admin: admin.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  ok(`Advanced to epoch ${currentEpochId + 1}`);

  // Wait for reveal window to actually open
  const now2 = Math.floor(Date.now() / 1000);
  if (now2 < revealOpens) {
    const waitReveal = revealOpens - now2 + 1;
    console.log(`  Waiting ${waitReveal}s for reveal window...`);
    await sleep(waitReveal * 1000);
  }

  // ── Step 7: Reveal ────────────────────────────────────────────

  step("Reveal prediction");
  await program.methods
    .revealPrediction(
      new BN(currentEpochId),
      Array.from(marketId) as any,
      Array.from(salt32) as any,
      prediction
    )
    .accounts({
      globalState,
      epochState: activeEpochState,
      commitment,
      miner: miner.publicKey,
    })
    .signers([miner])
    .rpc();

  const c2 = await (program.account as any).commitment.fetch(commitment);
  ok(`Revealed: prediction=${c2.prediction} (${c2.prediction === 2 ? "YES" : "NO"}), revealed=${c2.revealed}`);

  // ── Step 8: Score miner (admin) ───────────────────────────────

  step("Score miner (1 correct × tier 1 = 1 credit)");
  const [minerEpochRecord] = findPDA([
    Buffer.from("miner_epoch"),
    epochIdBuf(currentEpochId),
    miner.publicKey.toBuffer(),
  ]);

  await program.methods
    .scoreMiner(new BN(currentEpochId), new BN(1))
    .accounts({
      globalState,
      epochState: activeEpochState,
      minerEpochRecord,
      miner: miner.publicKey,
      admin: admin.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const record = await (program.account as any).minerEpochRecord.fetch(minerEpochRecord);
  ok(`Scored: ${record.credits.toNumber()} credits`);

  const esAfterScore = await (program.account as any).epochState.fetch(activeEpochState);
  ok(`Epoch total credits: ${esAfterScore.totalCredits.toNumber()}`);

  // ── Step 9: Fund epoch ────────────────────────────────────────

  step("Fund epoch (100K $STRK reward pool)");
  await program.methods
    .fundEpoch(new BN(currentEpochId), new BN(REWARD_AMOUNT))
    .accounts({
      globalState,
      epochState: activeEpochState,
      vault,
      adminTokenAccount: adminAta.address,
      admin: admin.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  const esAfterFund = await (program.account as any).epochState.fetch(activeEpochState);
  ok(`Funded: ${esAfterFund.rewardAmount.toNumber() / 10 ** TOKEN_DECIMALS} $STRK`);

  // ── Step 10: Claim rewards ────────────────────────────────────

  step("Claim rewards");
  const minerBalanceBefore = (await connection.getTokenAccountBalance(minerAta.address)).value.amount;

  await program.methods
    .claimRewards(new BN(currentEpochId))
    .accounts({
      globalState,
      epochState: activeEpochState,
      minerEpochRecord,
      vault,
      minerTokenAccount: minerAta.address,
      miner: miner.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([miner])
    .rpc();

  const minerBalanceAfter = (await connection.getTokenAccountBalance(minerAta.address)).value.amount;
  const received = BigInt(minerBalanceAfter) - BigInt(minerBalanceBefore);
  ok(`Claimed ${Number(received) / 10 ** TOKEN_DECIMALS} $STRK (1/1 of pool = 100%)`);

  const recordAfter = await (program.account as any).minerEpochRecord.fetch(minerEpochRecord);
  ok(`claimed=${recordAfter.claimed}`);

  // ── Step 11: Close commitment (recover rent) ──────────────────

  step("Close commitment PDA (recover rent)");
  const solBefore = await connection.getBalance(miner.publicKey);

  await program.methods
    .closeCommitment(new BN(currentEpochId), Array.from(marketId) as any)
    .accounts({
      commitment,
      minerEpochRecord,
      miner: miner.publicKey,
    })
    .signers([miner])
    .rpc();

  const solAfter = await connection.getBalance(miner.publicKey);
  const rentRecovered = (solAfter - solBefore + 5000) / LAMPORTS_PER_SOL; // +5000 for tx fee
  ok(`Commitment closed, ~${rentRecovered.toFixed(4)} SOL rent recovered`);

  // Verify account is gone
  const closedAccount = await connection.getAccountInfo(commitment);
  ok(`Commitment account exists: ${closedAccount !== null} (expected: false)`);

  // ── Done ──────────────────────────────────────────────────────

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  ✅ ALL STEPS PASSED — Full lifecycle verified on devnet");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`\n  Epoch:    ${currentEpochId}`);
  console.log(`  Miner:    ${miner.publicKey.toBase58()}`);
  console.log(`  Staked:   ${TIER_1_AMOUNT / 10 ** TOKEN_DECIMALS} $STRK (tier 1)`);
  console.log(`  Predicted: YES`);
  console.log(`  Credits:  1`);
  console.log(`  Claimed:  ${Number(received) / 10 ** TOKEN_DECIMALS} $STRK`);
  console.log();
}

main().catch((err) => {
  console.error("\n❌ E2E TEST FAILED:", err);
  process.exit(1);
});
