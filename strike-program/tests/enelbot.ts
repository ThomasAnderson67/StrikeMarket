import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Enelbot } from "../target/types/enelbot";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";
import { createHash } from "crypto";

// ── Constants matching the program ─────────────────────────────────────

const TOKEN_DECIMALS = 6;
const TIER_1_MINIMUM = 1_000_000 * 10 ** TOKEN_DECIMALS;   // 1M
const TIER_2_MINIMUM = 10_000_000 * 10 ** TOKEN_DECIMALS;  // 10M
const TIER_3_MINIMUM = 100_000_000 * 10 ** TOKEN_DECIMALS; // 100M

// Epoch timing (use short durations for testing)
const EPOCH_DURATION = 60;       // 60s epoch
const COMMIT_END_OFFSET = 40;    // commit window: 0-40s
const REVEAL_START_OFFSET = 60;  // reveal window: 60-80s
const REVEAL_END_OFFSET = 80;

// ── Helpers ────────────────────────────────────────────────────────────

function computePredictionHash(
  salt: Buffer,
  miner: PublicKey,
  epochId: number,
  marketId: Buffer,
  prediction: number
): Buffer {
  const epochBuf = Buffer.alloc(8);
  epochBuf.writeBigUInt64LE(BigInt(epochId));

  return createHash("sha256")
    .update(salt)
    .update(miner.toBuffer())
    .update(epochBuf)
    .update(marketId)
    .update(Buffer.from([prediction]))
    .digest();
}

function findPDA(seeds: (Buffer | Uint8Array)[], programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function airdrop(
  provider: anchor.AnchorProvider,
  to: PublicKey,
  lamports: number
): Promise<void> {
  const sig = await provider.connection.requestAirdrop(to, lamports);
  await provider.connection.confirmTransaction(sig, "confirmed");
}

// ── Test Suite ─────────────────────────────────────────────────────────

describe("strike", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Enelbot as Program<Enelbot>;
  const admin = provider.wallet as anchor.Wallet;

  let enelMint: PublicKey;
  let adminTokenAccount: PublicKey;
  let vault: PublicKey;
  let globalState: PublicKey;

  // Test market ID
  const marketId = Buffer.alloc(32);
  marketId.write("market_btc_100k", 0);

  // Miners
  const minerKeypair = Keypair.generate();
  let minerTokenAccount: PublicKey;

  const miner2Keypair = Keypair.generate();
  let miner2TokenAccount: PublicKey;

  // Salts and predictions
  const salt1 = Buffer.from(
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "hex"
  );
  const pred1 = 2; // YES

  const salt2 = Buffer.from(
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    "hex"
  );
  const pred2 = 1; // NO

  // PDA helper
  const epochIdBuf = (id: number): Buffer => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(id));
    return buf;
  };

  before(async () => {
    // Airdrop SOL to miners
    await airdrop(provider, minerKeypair.publicKey, 10 * LAMPORTS_PER_SOL);
    await airdrop(provider, miner2Keypair.publicKey, 10 * LAMPORTS_PER_SOL);

    // Create $STRK mint
    enelMint = await createMint(
      provider.connection,
      (admin as any).payer,
      admin.publicKey,
      null,
      TOKEN_DECIMALS
    );

    // Create token accounts
    adminTokenAccount = await createAccount(
      provider.connection,
      (admin as any).payer,
      enelMint,
      admin.publicKey
    );
    minerTokenAccount = await createAccount(
      provider.connection,
      (admin as any).payer,
      enelMint,
      minerKeypair.publicKey
    );
    miner2TokenAccount = await createAccount(
      provider.connection,
      (admin as any).payer,
      enelMint,
      miner2Keypair.publicKey
    );

    // Mint tokens: admin gets a large supply for funding epochs
    await mintTo(
      provider.connection,
      (admin as any).payer,
      enelMint,
      adminTokenAccount,
      admin.publicKey,
      1_000_000_000 * 10 ** TOKEN_DECIMALS // 1B tokens
    );

    // Mint tokens: miners get enough to stake at various tiers
    await mintTo(
      provider.connection,
      (admin as any).payer,
      enelMint,
      minerTokenAccount,
      admin.publicKey,
      TIER_3_MINIMUM * 2
    );
    await mintTo(
      provider.connection,
      (admin as any).payer,
      enelMint,
      miner2TokenAccount,
      admin.publicKey,
      TIER_2_MINIMUM * 2
    );

    // Derive PDAs
    [globalState] = findPDA([Buffer.from("global")], program.programId);
    [vault] = findPDA([Buffer.from("vault")], program.programId);
  });

  // ── Initialize ───────────────────────────────────────────────────

  describe("initialize", () => {
    it("creates global state and epoch 1", async () => {
      const [epochState] = findPDA(
        [Buffer.from("epoch"), epochIdBuf(1)],
        program.programId
      );

      await program.methods
        .initialize({
          epochDuration: new anchor.BN(EPOCH_DURATION),
          commitEndOffset: new anchor.BN(COMMIT_END_OFFSET),
          revealStartOffset: new anchor.BN(REVEAL_START_OFFSET),
          revealEndOffset: new anchor.BN(REVEAL_END_OFFSET),
          marketCount: 5,
        })
        .accounts({
          globalState,
          epochState,
          vault,
          enelMint,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const gs = await program.account.globalState.fetch(globalState);
      assert.equal(gs.currentEpoch.toNumber(), 1);
      assert.equal(gs.epochDuration.toNumber(), EPOCH_DURATION);
      assert.ok(gs.admin.equals(admin.publicKey));
      assert.ok(gs.enelMint.equals(enelMint));

      const es = await program.account.epochState.fetch(epochState);
      assert.equal(es.epochId.toNumber(), 1);
      assert.equal(es.marketCount, 5);
      assert.equal(es.funded, false);
    });
  });

  // ── Stake ────────────────────────────────────────────────────────

  describe("stake", () => {
    it("stakes minimum tier 1", async () => {
      const [minerState] = findPDA(
        [Buffer.from("miner"), minerKeypair.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .stake(new anchor.BN(TIER_1_MINIMUM))
        .accounts({
          globalState,
          minerState,
          vault,
          minerTokenAccount,
          miner: minerKeypair.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([minerKeypair])
        .rpc();

      const ms = await program.account.minerState.fetch(minerState);
      assert.equal(ms.tier, 1);
      assert.equal(ms.stakedAmount.toNumber(), TIER_1_MINIMUM);
      assert.equal(ms.unstakeRequestedAt.toNumber(), 0);
    });

    it("upgrades tier on additional stake", async () => {
      const [minerState] = findPDA(
        [Buffer.from("miner"), minerKeypair.publicKey.toBuffer()],
        program.programId
      );

      const additional = TIER_3_MINIMUM - TIER_1_MINIMUM;

      await program.methods
        .stake(new anchor.BN(additional))
        .accounts({
          globalState,
          minerState,
          vault,
          minerTokenAccount,
          miner: minerKeypair.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([minerKeypair])
        .rpc();

      const ms = await program.account.minerState.fetch(minerState);
      assert.equal(ms.tier, 3);
      assert.equal(ms.stakedAmount.toNumber(), TIER_3_MINIMUM);
    });

    it("rejects below minimum", async () => {
      const [miner2State] = findPDA(
        [Buffer.from("miner"), miner2Keypair.publicKey.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .stake(new anchor.BN(100))
          .accounts({
            globalState,
            minerState: miner2State,
            vault,
            minerTokenAccount: miner2TokenAccount,
            miner: miner2Keypair.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([miner2Keypair])
          .rpc();
        assert.fail("Should have thrown");
      } catch (err) {
        assert.include(err.toString(), "InsufficientStake");
      }
    });

    it("stakes miner2 at tier 2", async () => {
      const [miner2State] = findPDA(
        [Buffer.from("miner"), miner2Keypair.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .stake(new anchor.BN(TIER_2_MINIMUM))
        .accounts({
          globalState,
          minerState: miner2State,
          vault,
          minerTokenAccount: miner2TokenAccount,
          miner: miner2Keypair.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([miner2Keypair])
        .rpc();

      const ms = await program.account.minerState.fetch(miner2State);
      assert.equal(ms.tier, 2);
    });
  });

  // ── Commit Prediction ────────────────────────────────────────────

  describe("commit_prediction", () => {
    let hash1: Buffer;

    before(() => {
      hash1 = computePredictionHash(salt1, minerKeypair.publicKey, 1, marketId, pred1);
    });

    it("accepts valid commit in window", async () => {
      const [epochState] = findPDA(
        [Buffer.from("epoch"), epochIdBuf(1)],
        program.programId
      );
      const [minerState] = findPDA(
        [Buffer.from("miner"), minerKeypair.publicKey.toBuffer()],
        program.programId
      );
      const [commitment] = findPDA(
        [
          Buffer.from("commitment"),
          epochIdBuf(1),
          minerKeypair.publicKey.toBuffer(),
          marketId,
        ],
        program.programId
      );

      await program.methods
        .commitPrediction(
          Array.from(marketId) as any,
          Array.from(hash1) as any
        )
        .accounts({
          globalState,
          epochState,
          minerState,
          commitment,
          miner: minerKeypair.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([minerKeypair])
        .rpc();

      const c = await program.account.commitment.fetch(commitment);
      assert.deepEqual(Buffer.from(c.hash), hash1);
      assert.equal(c.revealed, false);
      assert.equal(c.prediction, 0);
    });

    it("rejects duplicate commit (same market)", async () => {
      const [epochState] = findPDA(
        [Buffer.from("epoch"), epochIdBuf(1)],
        program.programId
      );
      const [minerState] = findPDA(
        [Buffer.from("miner"), minerKeypair.publicKey.toBuffer()],
        program.programId
      );
      const [commitment] = findPDA(
        [
          Buffer.from("commitment"),
          epochIdBuf(1),
          minerKeypair.publicKey.toBuffer(),
          marketId,
        ],
        program.programId
      );

      try {
        await program.methods
          .commitPrediction(
            Array.from(marketId) as any,
            Array.from(hash1) as any
          )
          .accounts({
            globalState,
            epochState,
            minerState,
            commitment,
            miner: minerKeypair.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([minerKeypair])
          .rpc();
        assert.fail("Should have thrown");
      } catch (err) {
        // PDA already exists — Anchor rejects the init
        assert.ok(err);
      }
    });

    it("miner2 commits on same market", async () => {
      const hash2 = computePredictionHash(salt2, miner2Keypair.publicKey, 1, marketId, pred2);

      const [epochState] = findPDA(
        [Buffer.from("epoch"), epochIdBuf(1)],
        program.programId
      );
      const [miner2State] = findPDA(
        [Buffer.from("miner"), miner2Keypair.publicKey.toBuffer()],
        program.programId
      );
      const [commitment2] = findPDA(
        [
          Buffer.from("commitment"),
          epochIdBuf(1),
          miner2Keypair.publicKey.toBuffer(),
          marketId,
        ],
        program.programId
      );

      await program.methods
        .commitPrediction(
          Array.from(marketId) as any,
          Array.from(hash2) as any
        )
        .accounts({
          globalState,
          epochState,
          minerState: miner2State,
          commitment: commitment2,
          miner: miner2Keypair.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([miner2Keypair])
        .rpc();

      const c = await program.account.commitment.fetch(commitment2);
      assert.deepEqual(Buffer.from(c.hash), hash2);
    });
  });

  // ── Full Lifecycle: Reveal → Score → Fund → Claim → Close ───────

  describe("full lifecycle", () => {
    it("advances epoch to open reveal window for epoch 1", async () => {
      // Wait for epoch 1 to end
      await sleep((EPOCH_DURATION + 2) * 1000);

      const [currentEpochState] = findPDA(
        [Buffer.from("epoch"), epochIdBuf(1)],
        program.programId
      );
      const [newEpochState] = findPDA(
        [Buffer.from("epoch"), epochIdBuf(2)],
        program.programId
      );

      await program.methods
        .advanceEpoch(5)
        .accounts({
          globalState,
          currentEpochState,
          newEpochState,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const gs = await program.account.globalState.fetch(globalState);
      assert.equal(gs.currentEpoch.toNumber(), 2);
    });

    it("reveals miner1 prediction (hash match)", async () => {
      const [epochState] = findPDA(
        [Buffer.from("epoch"), epochIdBuf(1)],
        program.programId
      );
      const [commitment] = findPDA(
        [
          Buffer.from("commitment"),
          epochIdBuf(1),
          minerKeypair.publicKey.toBuffer(),
          marketId,
        ],
        program.programId
      );

      await program.methods
        .revealPrediction(
          new anchor.BN(1),
          Array.from(marketId) as any,
          Array.from(salt1) as any,
          pred1
        )
        .accounts({
          globalState,
          epochState,
          commitment,
          miner: minerKeypair.publicKey,
        })
        .signers([minerKeypair])
        .rpc();

      const c = await program.account.commitment.fetch(commitment);
      assert.equal(c.revealed, true);
      assert.equal(c.prediction, pred1);
    });

    it("rejects reveal with wrong salt (hash mismatch)", async () => {
      const [epochState] = findPDA(
        [Buffer.from("epoch"), epochIdBuf(1)],
        program.programId
      );
      const [commitment2] = findPDA(
        [
          Buffer.from("commitment"),
          epochIdBuf(1),
          miner2Keypair.publicKey.toBuffer(),
          marketId,
        ],
        program.programId
      );

      try {
        await program.methods
          .revealPrediction(
            new anchor.BN(1),
            Array.from(marketId) as any,
            Array.from(Buffer.alloc(32)) as any, // wrong salt
            pred2
          )
          .accounts({
            globalState,
            epochState,
            commitment: commitment2,
            miner: miner2Keypair.publicKey,
          })
          .signers([miner2Keypair])
          .rpc();
        assert.fail("Should have thrown");
      } catch (err) {
        assert.include(err.toString(), "HashMismatch");
      }
    });

    it("reveals miner2 prediction (correct hash)", async () => {
      const [epochState] = findPDA(
        [Buffer.from("epoch"), epochIdBuf(1)],
        program.programId
      );
      const [commitment2] = findPDA(
        [
          Buffer.from("commitment"),
          epochIdBuf(1),
          miner2Keypair.publicKey.toBuffer(),
          marketId,
        ],
        program.programId
      );

      await program.methods
        .revealPrediction(
          new anchor.BN(1),
          Array.from(marketId) as any,
          Array.from(salt2) as any,
          pred2
        )
        .accounts({
          globalState,
          epochState,
          commitment: commitment2,
          miner: miner2Keypair.publicKey,
        })
        .signers([miner2Keypair])
        .rpc();

      const c = await program.account.commitment.fetch(commitment2);
      assert.equal(c.revealed, true);
      assert.equal(c.prediction, pred2);
    });

    it("rejects double reveal", async () => {
      const [epochState] = findPDA(
        [Buffer.from("epoch"), epochIdBuf(1)],
        program.programId
      );
      const [commitment] = findPDA(
        [
          Buffer.from("commitment"),
          epochIdBuf(1),
          minerKeypair.publicKey.toBuffer(),
          marketId,
        ],
        program.programId
      );

      try {
        await program.methods
          .revealPrediction(
            new anchor.BN(1),
            Array.from(marketId) as any,
            Array.from(salt1) as any,
            pred1
          )
          .accounts({
            globalState,
            epochState,
            commitment,
            miner: minerKeypair.publicKey,
          })
          .signers([minerKeypair])
          .rpc();
        assert.fail("Should have thrown");
      } catch (err) {
        assert.include(err.toString(), "AlreadyRevealed");
      }
    });

    it("scores miners (admin)", async () => {
      const [epochState] = findPDA(
        [Buffer.from("epoch"), epochIdBuf(1)],
        program.programId
      );

      // Miner1: 1 correct * tier 3 = 3 credits
      const [record1] = findPDA(
        [Buffer.from("miner_epoch"), epochIdBuf(1), minerKeypair.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .scoreMiner(new anchor.BN(1), new anchor.BN(3))
        .accounts({
          globalState,
          epochState,
          minerEpochRecord: record1,
          miner: minerKeypair.publicKey,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Miner2: 1 correct * tier 2 = 2 credits
      const [record2] = findPDA(
        [Buffer.from("miner_epoch"), epochIdBuf(1), miner2Keypair.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .scoreMiner(new anchor.BN(1), new anchor.BN(2))
        .accounts({
          globalState,
          epochState,
          minerEpochRecord: record2,
          miner: miner2Keypair.publicKey,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const es = await program.account.epochState.fetch(epochState);
      assert.equal(es.totalCredits.toNumber(), 5); // 3 + 2
    });

    it("rejects credits exceeding max", async () => {
      const fakeMiner = Keypair.generate();
      const [epochState] = findPDA(
        [Buffer.from("epoch"), epochIdBuf(1)],
        program.programId
      );
      const [fakeRecord] = findPDA(
        [Buffer.from("miner_epoch"), epochIdBuf(1), fakeMiner.publicKey.toBuffer()],
        program.programId
      );

      try {
        // market_count=5, max_tier=3 → max credits=15
        await program.methods
          .scoreMiner(new anchor.BN(1), new anchor.BN(100))
          .accounts({
            globalState,
            epochState,
            minerEpochRecord: fakeRecord,
            miner: fakeMiner.publicKey,
            admin: admin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have thrown");
      } catch (err) {
        assert.include(err.toString(), "InvalidCredits");
      }
    });

    it("funds epoch 1", async () => {
      const rewardAmount = 1_000_000 * 10 ** TOKEN_DECIMALS; // 1M STRK
      const [epochState] = findPDA(
        [Buffer.from("epoch"), epochIdBuf(1)],
        program.programId
      );

      await program.methods
        .fundEpoch(new anchor.BN(1), new anchor.BN(rewardAmount))
        .accounts({
          globalState,
          epochState,
          vault,
          adminTokenAccount,
          admin: admin.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const es = await program.account.epochState.fetch(epochState);
      assert.equal(es.funded, true);
      assert.equal(es.rewardAmount.toNumber(), rewardAmount);
    });

    it("rejects double funding", async () => {
      const [epochState] = findPDA(
        [Buffer.from("epoch"), epochIdBuf(1)],
        program.programId
      );

      try {
        await program.methods
          .fundEpoch(new anchor.BN(1), new anchor.BN(1000))
          .accounts({
            globalState,
            epochState,
            vault,
            adminTokenAccount,
            admin: admin.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        assert.fail("Should have thrown");
      } catch (err) {
        assert.include(err.toString(), "AlreadyFunded");
      }
    });

    it("miner1 claims proportional share (3/5)", async () => {
      const rewardAmount = 1_000_000 * 10 ** TOKEN_DECIMALS;
      const [epochState] = findPDA(
        [Buffer.from("epoch"), epochIdBuf(1)],
        program.programId
      );
      const [record1] = findPDA(
        [Buffer.from("miner_epoch"), epochIdBuf(1), minerKeypair.publicKey.toBuffer()],
        program.programId
      );

      const balanceBefore = (await getAccount(provider.connection, minerTokenAccount)).amount;

      await program.methods
        .claimRewards(new anchor.BN(1))
        .accounts({
          globalState,
          epochState,
          minerEpochRecord: record1,
          vault,
          minerTokenAccount,
          miner: minerKeypair.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([minerKeypair])
        .rpc();

      const balanceAfter = (await getAccount(provider.connection, minerTokenAccount)).amount;

      // 3/5 * 1M = 600,000
      const expectedShare = Math.floor((rewardAmount * 3) / 5);
      const received = Number(balanceAfter - balanceBefore);
      assert.equal(received, expectedShare);

      const record = await program.account.minerEpochRecord.fetch(record1);
      assert.equal(record.claimed, true);
    });

    it("rejects double claim", async () => {
      const [epochState] = findPDA(
        [Buffer.from("epoch"), epochIdBuf(1)],
        program.programId
      );
      const [record1] = findPDA(
        [Buffer.from("miner_epoch"), epochIdBuf(1), minerKeypair.publicKey.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .claimRewards(new anchor.BN(1))
          .accounts({
            globalState,
            epochState,
            minerEpochRecord: record1,
            vault,
            minerTokenAccount,
            miner: minerKeypair.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([minerKeypair])
          .rpc();
        assert.fail("Should have thrown");
      } catch (err) {
        assert.include(err.toString(), "AlreadyClaimed");
      }
    });

    it("miner2 claims remaining (2/5)", async () => {
      const rewardAmount = 1_000_000 * 10 ** TOKEN_DECIMALS;
      const [epochState] = findPDA(
        [Buffer.from("epoch"), epochIdBuf(1)],
        program.programId
      );
      const [record2] = findPDA(
        [Buffer.from("miner_epoch"), epochIdBuf(1), miner2Keypair.publicKey.toBuffer()],
        program.programId
      );

      const balanceBefore = (await getAccount(provider.connection, miner2TokenAccount)).amount;

      await program.methods
        .claimRewards(new anchor.BN(1))
        .accounts({
          globalState,
          epochState,
          minerEpochRecord: record2,
          vault,
          minerTokenAccount: miner2TokenAccount,
          miner: miner2Keypair.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([miner2Keypair])
        .rpc();

      const balanceAfter = (await getAccount(provider.connection, miner2TokenAccount)).amount;

      const expectedShare = Math.floor((rewardAmount * 2) / 5);
      const received = Number(balanceAfter - balanceBefore);
      assert.equal(received, expectedShare);

      const es = await program.account.epochState.fetch(epochState);
      assert.equal(
        es.totalClaimed.toNumber(),
        Math.floor((rewardAmount * 3) / 5) + Math.floor((rewardAmount * 2) / 5)
      );
    });

    it("closes commitment after claim (rent refund)", async () => {
      const [commitment] = findPDA(
        [
          Buffer.from("commitment"),
          epochIdBuf(1),
          minerKeypair.publicKey.toBuffer(),
          marketId,
        ],
        program.programId
      );
      const [record1] = findPDA(
        [Buffer.from("miner_epoch"), epochIdBuf(1), minerKeypair.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .closeCommitment(new anchor.BN(1), Array.from(marketId) as any)
        .accounts({
          commitment,
          minerEpochRecord: record1,
          miner: minerKeypair.publicKey,
        })
        .signers([minerKeypair])
        .rpc();

      // Commitment account should be closed
      const info = await provider.connection.getAccountInfo(commitment);
      assert.isNull(info);
    });
  });

  // ── Unstake / Withdraw ───────────────────────────────────────────

  describe("unstake and withdraw", () => {
    it("unstake sets cooldown and removes tier", async () => {
      const [minerState] = findPDA(
        [Buffer.from("miner"), miner2Keypair.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .unstake()
        .accounts({
          minerState,
          miner: miner2Keypair.publicKey,
        })
        .signers([miner2Keypair])
        .rpc();

      const ms = await program.account.minerState.fetch(minerState);
      assert.equal(ms.tier, 0);
      assert.ok(ms.unstakeRequestedAt.toNumber() > 0);
    });

    it("rejects withdraw before cooldown", async () => {
      const [minerState] = findPDA(
        [Buffer.from("miner"), miner2Keypair.publicKey.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .withdraw()
          .accounts({
            globalState,
            minerState,
            vault,
            minerTokenAccount: miner2TokenAccount,
            miner: miner2Keypair.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([miner2Keypair])
          .rpc();
        assert.fail("Should have thrown");
      } catch (err) {
        assert.include(err.toString(), "CooldownNotElapsed");
      }
    });

    it("rejects stake while unstake is pending", async () => {
      const [minerState] = findPDA(
        [Buffer.from("miner"), miner2Keypair.publicKey.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .stake(new anchor.BN(TIER_1_MINIMUM))
          .accounts({
            globalState,
            minerState,
            vault,
            minerTokenAccount: miner2TokenAccount,
            miner: miner2Keypair.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([miner2Keypair])
          .rpc();
        assert.fail("Should have thrown");
      } catch (err) {
        assert.include(err.toString(), "UnstakePending");
      }
    });
  });

  // ── Advance Epoch (edge cases) ──────────────────────────────────

  describe("advance_epoch", () => {
    it("rejects if epoch not ended", async () => {
      const [currentEpochState] = findPDA(
        [Buffer.from("epoch"), epochIdBuf(2)],
        program.programId
      );
      const [newEpochState] = findPDA(
        [Buffer.from("epoch"), epochIdBuf(3)],
        program.programId
      );

      try {
        await program.methods
          .advanceEpoch(3)
          .accounts({
            globalState,
            currentEpochState,
            newEpochState,
            admin: admin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        assert.fail("Should have thrown");
      } catch (err) {
        assert.include(err.toString(), "EpochNotEnded");
      }
    });
  });
});
