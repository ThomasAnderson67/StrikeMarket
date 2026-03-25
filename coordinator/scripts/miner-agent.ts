#!/usr/bin/env npx tsx
/**
 * Strike AI Miner Agent — Devnet (Continuous Mining)
 *
 * A fully autonomous miner that continuously mines crypto 15-min rounds
 * within an epoch through the coordinator API.
 *
 *   Setup:   fund miner -> stake on-chain -> auth via coordinator
 *   Loop:    get round -> predict -> commit -> wait for resolution -> reveal -> repeat
 *   Claim:   after epoch ends, check credits and claim rewards
 *
 * Usage:
 *   npx tsx scripts/miner-agent.ts [--rounds N]
 *
 * Flags:
 *   --rounds N  Limit how many rounds to mine (default: 3 for testing)
 *
 * Env vars:
 *   COORDINATOR_URL  — coordinator base URL (default: Railway production)
 *   SOLANA_RPC_URL   — Solana RPC (default: devnet)
 *   MINER_KEYPAIR    — path to miner keypair JSON (default: generates new one)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  transfer,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { createHash, randomBytes } from "crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import fs from "fs";

// ── Config ──────────────────────────────────────────────────────────

const COORDINATOR_URL =
  process.env.COORDINATOR_URL ||
  "https://strike-coordinator-production.up.railway.app";
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "73aZc4WACFdJ288yQmEq9RsGS3neC3P3keqGXmGktVh7"
);
const STRK_MINT = new PublicKey(
  "DtGRMG6Qw47Rqm6bQ6aY32TPv6Q9rUaSBzZezHpM3sHk"
);

const TOKEN_DECIMALS = 6;
const TIER_1_AMOUNT = 1_000_000 * 10 ** TOKEN_DECIMALS; // 1M tokens

/** How often to poll for new rounds / reveal readiness (seconds) */
const POLL_INTERVAL_S = 15;

/** How long to wait after a round ends before attempting reveal (seconds) */
const REVEAL_DELAY_S = 10;

// ── CLI args ────────────────────────────────────────────────────────

function parseArgs(): { maxRounds: number } {
  const args = process.argv.slice(2);
  let maxRounds = 3; // default: 3 rounds for testing

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rounds" && args[i + 1]) {
      maxRounds = parseInt(args[i + 1], 10);
      if (isNaN(maxRounds) || maxRounds < 1) {
        console.error("--rounds must be a positive integer");
        process.exit(1);
      }
      i++;
    }
  }

  return { maxRounds };
}

// ── Types ───────────────────────────────────────────────────────────

interface PredictionEntry {
  marketId: string;
  question: string;
  prediction: number; // 1=NO (Down), 2=YES (Up)
  salt: Buffer;
  hash: Buffer;
}

interface RoundPredictions {
  roundId: number;
  epochId: number;
  endsAt: number;
  predictions: PredictionEntry[];
  committed: boolean;
  revealed: boolean;
}

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
  console.log(`  [ok] ${msg}`);
}
function info(msg: string) {
  console.log(`  [..] ${msg}`);
}
function warn(msg: string) {
  console.log(`  [!!] ${msg}`);
}
function step(msg: string) {
  console.log(`\n> ${msg}`);
}

function formatTimeLeft(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ── API Helpers ─────────────────────────────────────────────────────

async function api(
  path: string,
  options: {
    method?: string;
    body?: any;
    token?: string;
    query?: Record<string, string>;
  } = {}
): Promise<any> {
  let url = `${COORDINATOR_URL}${path}`;
  if (options.query) {
    const params = new URLSearchParams(options.query);
    url += `?${params.toString()}`;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options.token) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }

  const res = await fetch(url, {
    method: options.method || (options.body ? "POST" : "GET"),
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `API ${options.method || "GET"} ${path} -> ${res.status}: ${JSON.stringify(data)}`
    );
  }
  return data;
}

/** Sign a base64 transaction and submit it to Solana */
async function signAndSubmit(
  connection: Connection,
  txBase64: string,
  signer: Keypair
): Promise<string> {
  const txBuf = Buffer.from(txBase64, "base64");

  // Try as VersionedTransaction first, fall back to legacy
  let sig: string;
  try {
    const vtx = VersionedTransaction.deserialize(txBuf);
    vtx.sign([signer]);
    sig = await connection.sendTransaction(vtx, { skipPreflight: false });
  } catch {
    const tx = Transaction.from(txBuf);
    tx.partialSign(signer);
    sig = await connection.sendRawTransaction(tx.serialize());
  }

  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

// ── Auth Helper ─────────────────────────────────────────────────────

/** Authenticate with the coordinator API, returns JWT and expiry */
async function authenticate(
  miner: Keypair
): Promise<{ jwt: string; expiresAt: number }> {
  const nonceResp = await api("/v1/auth/nonce", {
    body: { miner: miner.publicKey.toBase58() },
  });

  const messageBytes = new TextEncoder().encode(nonceResp.message);
  const signature = nacl.sign.detached(messageBytes, miner.secretKey);
  const signatureB58 = bs58.encode(signature);

  const authResp = await api("/v1/auth/verify", {
    body: {
      miner: miner.publicKey.toBase58(),
      message: nonceResp.message,
      signature: signatureB58,
    },
  });

  return { jwt: authResp.token, expiresAt: authResp.expiresAt };
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const { maxRounds } = parseArgs();

  console.log("===================================================");
  console.log("  Strike AI Miner Agent — Continuous Mining");
  console.log("===================================================");

  const connection = new Connection(RPC_URL, "confirmed");
  const admin = loadKeypair("~/.config/solana/id.json");

  // Load or generate miner keypair (persisted to disk for re-runs)
  const minerKeyPath = new URL("../miner-keypair.json", import.meta.url).pathname;
  let miner: Keypair;
  if (process.env.MINER_KEYPAIR) {
    miner = loadKeypair(process.env.MINER_KEYPAIR);
    info(`Loaded miner from env: ${miner.publicKey.toBase58()}`);
  } else if (fs.existsSync(minerKeyPath)) {
    miner = loadKeypair(minerKeyPath);
    info(`Loaded existing miner: ${miner.publicKey.toBase58()}`);
  } else {
    miner = Keypair.generate();
    fs.writeFileSync(minerKeyPath, JSON.stringify(Array.from(miner.secretKey)));
    info(`Generated new miner: ${miner.publicKey.toBase58()}`);
    info(`Keypair saved to ${minerKeyPath}`);
  }

  console.log(`\n  Admin:       ${admin.publicKey.toBase58()}`);
  console.log(`  Miner:       ${miner.publicKey.toBase58()}`);
  console.log(`  Coordinator: ${COORDINATOR_URL}`);
  console.log(`  RPC:         ${RPC_URL}`);
  console.log(`  Max rounds:  ${maxRounds}`);

  // ── Step 1: Check coordinator health ──────────────────────────

  step("Check coordinator health");
  const health = await api("/v1/health");
  ok(`Coordinator live -- epoch ${health.currentEpoch}, ${health.challengeMarkets} markets`);

  const stats = await api("/v1/stats");
  info(`Phase: ${stats.phase}, miners: ${stats.activeMiners}/${stats.totalMiners}`);

  // ── Step 2: Fund miner with SOL ───────────────────────────────

  step("Fund miner with SOL");
  const minerBalance = await connection.getBalance(miner.publicKey);
  if (minerBalance < 0.05 * LAMPORTS_PER_SOL) {
    try {
      const sig = await connection.requestAirdrop(
        miner.publicKey,
        0.1 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");
      ok("Airdropped 0.1 SOL");
    } catch {
      info("Airdrop rate-limited, transferring from admin...");
      const wallet = new anchor.Wallet(admin);
      const provider = new anchor.AnchorProvider(connection, wallet, {
        commitment: "confirmed",
      });
      const tx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: miner.publicKey,
          lamports: 0.1 * LAMPORTS_PER_SOL,
        })
      );
      await provider.sendAndConfirm(tx);
      ok("Transferred 0.1 SOL from admin");
    }
  } else {
    ok(`Already funded (${(minerBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
  }

  // ── Step 3: Fund miner with tokens + stake ────────────────────

  step("Fund miner with tokens and stake");

  const [minerState] = findPDA([
    Buffer.from("miner"),
    miner.publicKey.toBuffer(),
  ]);
  const [globalState] = findPDA([Buffer.from("global")]);
  const [vault] = findPDA([Buffer.from("vault")]);

  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const idlPath = new URL("../../strike-program/target/idl/strike.json", import.meta.url);
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new anchor.Program(idl, provider);

  let alreadyStaked = false;
  try {
    const ms = await (program.account as any).minerState.fetch(minerState);
    if (ms.tier >= 1) {
      ok(`Already staked -- tier ${ms.tier}`);
      alreadyStaked = true;
    }
  } catch {
    // Not staked yet
  }

  if (!alreadyStaked) {
    const adminAta = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      STRK_MINT,
      admin.publicKey
    );
    const minerAta = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      STRK_MINT,
      miner.publicKey
    );
    await transfer(
      connection,
      admin,
      adminAta.address,
      minerAta.address,
      admin,
      BigInt(TIER_1_AMOUNT)
    );
    ok(`Transferred ${TIER_1_AMOUNT / 10 ** TOKEN_DECIMALS} tokens to miner`);

    const minerProvider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(miner),
      { commitment: "confirmed" }
    );
    const minerProgram = new anchor.Program(idl, minerProvider);

    // Read current epoch for epoch_state account (needed for mining fee pool)
    const gs = await (program.account as any).globalState.fetch(globalState);
    const currentEpochId = gs.currentEpoch.toNumber();
    const [epochStatePda] = findPDA([Buffer.from("epoch"), epochIdBuf(currentEpochId)]);

    await minerProgram.methods
      .stake(new BN(TIER_1_AMOUNT))
      .accounts({
        globalState,
        epochState: epochStatePda,
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
    ok(`Staked ${TIER_1_AMOUNT / 10 ** TOKEN_DECIMALS} tokens -- tier ${ms.tier} (1% mining fee added to epoch reward pool)`);
  }

  // ── Step 4: Authenticate via coordinator API ──────────────────

  step("Authenticate with coordinator");
  let auth = await authenticate(miner);
  let jwt = auth.jwt;
  let jwtExpiresAt = auth.expiresAt;
  ok(`Authenticated -- JWT expires at ${new Date(jwtExpiresAt * 1000).toISOString()}`);

  /** Re-authenticate if JWT is expired or about to expire (within 60s) */
  async function ensureAuth(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    if (now >= jwtExpiresAt - 60) {
      info("JWT expiring soon, re-authenticating...");
      auth = await authenticate(miner);
      jwt = auth.jwt;
      jwtExpiresAt = auth.expiresAt;
      ok("Re-authenticated");
    }
  }

  // ── Step 5: Continuous Mining Loop ────────────────────────────

  step(`Starting continuous mining loop (max ${maxRounds} rounds)`);

  /** Track predictions per round */
  const roundPredictions = new Map<number, RoundPredictions>();

  /** Set of round IDs we have already committed for */
  const committedRounds = new Set<number>();

  let roundsMined = 0;
  let totalCommitted = 0;
  let totalRevealed = 0;
  let startingEpochId: number | null = null;

  // Handle Ctrl+C gracefully
  let running = true;
  process.on("SIGINT", () => {
    console.log("\n\n  [!!] Ctrl+C received -- finishing up...");
    running = false;
  });

  while (running && roundsMined < maxRounds) {
    try {
      await ensureAuth();

      // Check scheduler for epoch state
      const scheduler = await api("/v1/scheduler");

      if (startingEpochId === null) {
        startingEpochId = scheduler.epochId;
      }

      // If epoch advanced past our starting epoch, stop mining
      if (scheduler.epochId > startingEpochId) {
        info(`Epoch advanced to ${scheduler.epochId} -- exiting mining loop`);
        break;
      }

      // If not in commit phase, we can only reveal (or wait)
      if (scheduler.phase !== "commit") {
        info(`Phase is '${scheduler.phase}', not 'commit' -- waiting for next round`);

        // Try to reveal any pending rounds while we wait
        await tryRevealPendingRounds(
          connection, miner, jwt, scheduler.epochId, roundPredictions
        );

        // If we're past scoring, break out
        if (scheduler.phase === "scoring" || scheduler.phase === "advancing") {
          info("Epoch is in scoring/advancing phase -- exiting mining loop");
          break;
        }

        await sleep(POLL_INTERVAL_S * 1000);
        continue;
      }

      // ── Check for current round ──

      const roundInfo = await api("/v1/round");

      if (!roundInfo.active) {
        info("No active round -- waiting for next 15-min round...");

        // Try reveals while waiting
        await tryRevealPendingRounds(
          connection, miner, jwt, scheduler.epochId, roundPredictions
        );

        await sleep(POLL_INTERVAL_S * 1000);
        continue;
      }

      const roundId = roundInfo.roundId as number;

      // Already committed for this round? Skip commit, try reveals instead.
      if (committedRounds.has(roundId)) {
        // Try to reveal any past rounds whose endTime has passed
        const revealed = await tryRevealPendingRounds(
          connection, miner, jwt, scheduler.epochId, roundPredictions
        );

        if (revealed > 0) {
          totalRevealed += revealed;
        }

        // Wait before polling again
        const timeLeft = roundInfo.roundEndsAt - Math.floor(Date.now() / 1000);
        if (timeLeft > 0) {
          const waitTime = Math.min(timeLeft + REVEAL_DELAY_S, POLL_INTERVAL_S);
          info(`Round ${roundId} already committed. Waiting ${formatTimeLeft(waitTime)} for round to end...`);
          await sleep(waitTime * 1000);
        } else {
          await sleep(POLL_INTERVAL_S * 1000);
        }
        continue;
      }

      // ── Get challenge for this round ──

      step(`Round ${roundId}: Getting challenge`);
      const challenge = await api("/v1/challenge", { token: jwt });

      if (challenge.skipped || !challenge.markets || challenge.markets.length === 0) {
        warn("No markets in this round -- waiting...");
        await sleep(POLL_INTERVAL_S * 1000);
        continue;
      }

      const epochId = challenge.epochId as number;
      info(`Epoch ${epochId}, Round ${roundId}: ${challenge.marketCount} markets`);
      info(`Round ends at: ${new Date((challenge.roundEndsAt as number) * 1000).toISOString()}`);

      // ── Generate predictions ──

      const predictions: PredictionEntry[] = [];

      for (const market of challenge.markets) {
        const salt = randomBytes(32);
        const marketIdBuf = Buffer.from(market.marketId, "hex");
        // Crypto prediction: Up=YES(2), Down=NO(1) -- random 50/50 for testing
        const prediction = Math.random() > 0.5 ? 2 : 1;
        const hash = computeHash(
          salt,
          miner.publicKey,
          epochId,
          marketIdBuf,
          prediction
        );

        predictions.push({
          marketId: market.marketId,
          question: market.question,
          prediction,
          salt,
          hash,
        });
      }

      const upCount = predictions.filter((p) => p.prediction === 2).length;
      const downCount = predictions.filter((p) => p.prediction === 1).length;
      info(`Predictions: ${upCount} Up (YES), ${downCount} Down (NO)`);

      // ── Commit predictions ──

      let commitCount = 0;
      for (const pred of predictions) {
        try {
          const resp = await api("/v1/submit-commit", {
            token: jwt,
            body: {
              miner: miner.publicKey.toBase58(),
              marketId: pred.marketId,
              hash: pred.hash.toString("hex"),
            },
          });

          const sig = await signAndSubmit(connection, resp.transaction, miner);
          commitCount++;
          const label = pred.prediction === 2 ? "Up " : "Dwn";
          const shortQ =
            pred.question.length > 45
              ? pred.question.slice(0, 45) + "..."
              : pred.question;
          console.log(
            `    [${commitCount}/${predictions.length}] ${label} ${shortQ} (tx: ${sig.slice(0, 8)}...)`
          );
        } catch (err: any) {
          console.error(`    [ERR] Commit failed for ${pred.marketId.slice(0, 8)}...: ${err.message}`);
        }
      }

      ok(`Committed ${commitCount}/${predictions.length} predictions for round ${roundId}`);
      totalCommitted += commitCount;

      // Store round predictions for later reveal
      const roundEntry: RoundPredictions = {
        roundId,
        epochId,
        endsAt: challenge.roundEndsAt as number,
        predictions,
        committed: true,
        revealed: false,
      };
      roundPredictions.set(roundId, roundEntry);
      committedRounds.add(roundId);
      roundsMined++;

      info(`Rounds mined: ${roundsMined}/${maxRounds}`);

      // ── Save reveal data to disk (crash recovery) ──

      saveRevealData(epochId, miner, roundPredictions);

      // ── Try to reveal any past rounds that are ready ──

      const revealed = await tryRevealPendingRounds(
        connection, miner, jwt, epochId, roundPredictions
      );
      totalRevealed += revealed;

    } catch (err: any) {
      console.error(`  [ERR] Mining loop error: ${err.message}`);
      await sleep(POLL_INTERVAL_S * 1000);
    }
  }

  // ── Post-loop: reveal any remaining rounds ──────────────────────

  step("Revealing remaining predictions");

  // Wait for the last round's markets to end
  const pendingRounds = Array.from(roundPredictions.values()).filter(
    (r) => r.committed && !r.revealed
  );

  if (pendingRounds.length > 0) {
    const latestEnd = Math.max(...pendingRounds.map((r) => r.endsAt));
    const now = Math.floor(Date.now() / 1000);

    if (now < latestEnd) {
      const waitSec = latestEnd - now + REVEAL_DELAY_S;
      info(`Waiting ${formatTimeLeft(waitSec)} for last round to end before revealing...`);
      await sleep(waitSec * 1000);
    }

    await ensureAuth();

    const revealed = await tryRevealPendingRounds(
      connection, miner, jwt, startingEpochId!, roundPredictions
    );
    totalRevealed += revealed;
  } else {
    ok("All rounds already revealed");
  }

  // ── Wait for scoring + claim ──────────────────────────────────

  step("Waiting for scoring...");
  info("Scoring happens automatically after the epoch closes.");
  info("Polling scheduler status...");

  let scored = false;
  for (let i = 0; i < 120; i++) {
    // Poll for up to 20 minutes
    await sleep(10_000);
    const status = await api("/v1/scheduler");
    if (
      status.phase === "commit" &&
      status.epochId > startingEpochId!
    ) {
      ok(`Epoch ${startingEpochId} scored and advanced to epoch ${status.epochId}`);
      scored = true;
      break;
    }
    if (i % 6 === 0) {
      info(`Still ${status.phase} (epoch ${status.epochId})...`);
    }
  }

  if (!scored) {
    warn("Scoring did not complete within 20 minutes.");
    warn("You can claim manually later using the reveal data file.");
    printSummary(startingEpochId!, miner, roundsMined, totalCommitted, totalRevealed, roundPredictions);
    return;
  }

  // ── Check credits ──────────────────────────────────────────────

  step("Check miner credits");
  const credits = await api("/v1/credits", {
    query: { miner: miner.publicKey.toBase58() },
  });
  info(`Credits: ${JSON.stringify(credits)}`);

  // ── Claim rewards ──────────────────────────────────────────────

  step("Claim rewards");
  await ensureAuth();

  const minerAta = await getAssociatedTokenAddress(STRK_MINT, miner.publicKey);

  try {
    const claimResp = await api("/v1/claim-calldata", {
      token: jwt,
      query: {
        epochs: String(startingEpochId),
        miner: miner.publicKey.toBase58(),
        minerTokenAccount: minerAta.toBase58(),
      },
    });

    for (const tx of claimResp.transactions) {
      const claimSig = await signAndSubmit(connection, tx.transaction, miner);
      ok(`Claimed epoch ${tx.epochId} rewards (tx: ${claimSig.slice(0, 12)}...)`);
    }
  } catch (err: any) {
    console.error(`  [ERR] Claim failed: ${err.message}`);
  }

  // ── Close commitments ──────────────────────────────────────────

  step("Close commitment PDAs (recover rent)");
  await ensureAuth();

  let closedCount = 0;
  const allPredictions = Array.from(roundPredictions.values()).flatMap(
    (r) => r.predictions.map((p) => ({ ...p, epochId: r.epochId }))
  );

  for (const pred of allPredictions) {
    try {
      const closeResp = await api("/v1/close-commitment-calldata", {
        token: jwt,
        query: {
          epochId: String(pred.epochId),
          miner: miner.publicKey.toBase58(),
          marketId: pred.marketId,
        },
      });

      await signAndSubmit(connection, closeResp.transaction, miner);
      closedCount++;
    } catch {
      // May fail if commitment was already closed or not scored
    }
  }
  ok(`Closed ${closedCount}/${allPredictions.length} commitment PDAs`);

  // ── Done ──────────────────────────────────────────────────────

  printSummary(startingEpochId!, miner, roundsMined, totalCommitted, totalRevealed, roundPredictions);
}

// ── Reveal Helper ───────────────────────────────────────────────────

/**
 * Try to reveal predictions for all rounds whose endTime has passed.
 * Returns the number of individual predictions revealed.
 */
async function tryRevealPendingRounds(
  connection: Connection,
  miner: Keypair,
  jwt: string,
  epochId: number,
  roundPredictions: Map<number, RoundPredictions>
): Promise<number> {
  let totalRevealed = 0;
  const now = Math.floor(Date.now() / 1000);

  for (const [roundId, round] of roundPredictions) {
    if (!round.committed || round.revealed) continue;

    // Only reveal after the round's markets have ended (+ delay buffer)
    if (now < round.endsAt + REVEAL_DELAY_S) continue;

    step(`Revealing round ${roundId} predictions`);

    let revealCount = 0;
    for (const pred of round.predictions) {
      try {
        const resp = await api("/v1/submit-reveal", {
          token: jwt,
          body: {
            miner: miner.publicKey.toBase58(),
            epochId,
            marketId: pred.marketId,
            salt: pred.salt.toString("hex"),
            prediction: pred.prediction,
          },
        });

        const sig = await signAndSubmit(connection, resp.transaction, miner);
        revealCount++;
        const label = pred.prediction === 2 ? "Up " : "Dwn";
        console.log(
          `    [${revealCount}/${round.predictions.length}] Revealed ${label} (tx: ${sig.slice(0, 8)}...)`
        );
      } catch (err: any) {
        console.error(
          `    [ERR] Reveal failed for ${pred.marketId.slice(0, 8)}...: ${err.message}`
        );
      }
    }

    round.revealed = true;
    totalRevealed += revealCount;
    ok(`Revealed ${revealCount}/${round.predictions.length} predictions for round ${roundId}`);
  }

  return totalRevealed;
}

// ── Persistence ─────────────────────────────────────────────────────

/** Save all round predictions to disk for crash recovery */
function saveRevealData(
  epochId: number,
  miner: Keypair,
  roundPredictions: Map<number, RoundPredictions>
): void {
  const data = {
    epochId,
    miner: miner.publicKey.toBase58(),
    minerSecretKey: Array.from(miner.secretKey),
    rounds: Array.from(roundPredictions.entries()).map(([roundId, rp]) => ({
      roundId,
      endsAt: rp.endsAt,
      committed: rp.committed,
      revealed: rp.revealed,
      predictions: rp.predictions.map((p) => ({
        marketId: p.marketId,
        prediction: p.prediction,
        salt: p.salt.toString("hex"),
      })),
    })),
    savedAt: new Date().toISOString(),
  };

  const revealPath = new URL(
    `../reveal-data-epoch-${epochId}.json`,
    import.meta.url
  );
  fs.writeFileSync(revealPath, JSON.stringify(data, null, 2));
}

// ── Summary ─────────────────────────────────────────────────────────

function printSummary(
  epochId: number,
  miner: Keypair,
  roundsMined: number,
  totalCommitted: number,
  totalRevealed: number,
  roundPredictions: Map<number, RoundPredictions>
): void {
  const allPreds = Array.from(roundPredictions.values()).flatMap((r) => r.predictions);

  console.log("\n===================================================");
  console.log("  MINER AGENT COMPLETE -- Continuous Mining");
  console.log("===================================================");
  console.log(`\n  Epoch:       ${epochId}`);
  console.log(`  Miner:       ${miner.publicKey.toBase58()}`);
  console.log(`  Rounds:      ${roundsMined}`);
  console.log(`  Committed:   ${totalCommitted}/${allPreds.length} predictions`);
  console.log(`  Revealed:    ${totalRevealed}/${allPreds.length} predictions`);

  for (const [roundId, rp] of roundPredictions) {
    const upCount = rp.predictions.filter((p) => p.prediction === 2).length;
    const downCount = rp.predictions.filter((p) => p.prediction === 1).length;
    const status = rp.revealed ? "revealed" : rp.committed ? "committed" : "pending";
    console.log(`    Round ${roundId}: ${rp.predictions.length} markets (${upCount} Up, ${downCount} Down) [${status}]`);
  }

  console.log();
}

// ── Entry point ─────────────────────────────────────────────────────

main().catch((err) => {
  console.error("\n[FATAL] MINER AGENT FAILED:", err);
  process.exit(1);
});
