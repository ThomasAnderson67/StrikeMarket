import { Connection, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Config } from "../config.js";
import * as pda from "../pda.js";
import idl from "../strike-idl.json" with { type: "json" };

// ── Solana service ─────────────────────────────────────────────────────
//
// Builds unsigned Solana transactions for program instructions.
// The coordinator signs admin TXs; miner TXs are returned unsigned
// for the miner's agent to sign and submit.
//
// Data flow:
//   Route handler → SolanaService.buildXxxTx() → unsigned Transaction
//   Miner agent signs → submits to RPC

export class SolanaService {
  public connection: Connection;
  private config: Config;
  private program: anchor.Program;
  private provider: anchor.AnchorProvider;

  constructor(config: Config) {
    this.config = config;
    this.connection = new Connection(config.rpcUrl, "confirmed");

    // Set up Anchor provider with admin wallet for reading state
    const wallet = new anchor.Wallet(config.adminKeypair);
    this.provider = new anchor.AnchorProvider(this.connection, wallet, {
      commitment: "confirmed",
    });
    this.program = new anchor.Program(idl as any, this.provider);
  }

  // ── State readers ──────────────────────────────────────────────

  async getGlobalState() {
    const [addr] = pda.findGlobalState(this.config.programId);
    return (this.program.account as any).globalState.fetch(addr);
  }

  async getEpochState(epochId: number) {
    const [addr] = pda.findEpochState(epochId, this.config.programId);
    return (this.program.account as any).epochState.fetch(addr);
  }

  async getMinerState(miner: PublicKey) {
    const [addr] = pda.findMinerState(miner, this.config.programId);
    try {
      return await (this.program.account as any).minerState.fetch(addr);
    } catch {
      return null; // Not staked
    }
  }

  async getCommitment(epochId: number, miner: PublicKey, marketId: Buffer) {
    const [addr] = pda.findCommitment(epochId, miner, marketId, this.config.programId);
    try {
      return await (this.program.account as any).commitment.fetch(addr);
    } catch {
      return null;
    }
  }

  async getMinerEpochRecord(epochId: number, miner: PublicKey) {
    const [addr] = pda.findMinerEpochRecord(epochId, miner, this.config.programId);
    try {
      return await (this.program.account as any).minerEpochRecord.fetch(addr);
    } catch {
      return null;
    }
  }

  // ── Stats aggregation ─────────────────────────────────────────

  /** Get vault token balance */
  async getVaultBalance(): Promise<{ amount: string; uiAmount: number | null }> {
    const [vaultAddr] = pda.findVault(this.config.programId);
    const balance = await this.connection.getTokenAccountBalance(vaultAddr);
    return { amount: balance.value.amount, uiAmount: balance.value.uiAmount };
  }

  /**
   * Aggregate miner stats from on-chain MinerState accounts.
   *
   * MinerState layout (after 8-byte Anchor discriminator):
   *   miner:              32 bytes  (offset 8)
   *   staked_amount:       8 bytes  (offset 40)
   *   tier:                1 byte   (offset 48)
   *   unstake_requested_at: 8 bytes (offset 49)
   *   bump:                1 byte   (offset 57)
   *   Total:              58 bytes
   */
  static readonly MINER_STATE_SIZE = 58;
  static readonly MINER_STAKED_OFFSET = 40; // 8 disc + 32 miner
  static readonly MINER_TIER_OFFSET = 48;   // 8 disc + 32 miner + 8 staked

  async getMinerStats(): Promise<{
    activeMiners: number;
    totalMiners: number;
    totalStaked: bigint;
  }> {
    const accounts = await this.connection.getProgramAccounts(this.config.programId, {
      filters: [{ dataSize: SolanaService.MINER_STATE_SIZE }],
    });

    let totalStaked = BigInt(0);
    let activeMiners = 0;
    for (const { account } of accounts) {
      const data = account.data;
      const stakedAmount = data.readBigUInt64LE(SolanaService.MINER_STAKED_OFFSET);
      const tier = data[SolanaService.MINER_TIER_OFFSET];
      if (tier > 0) activeMiners++;
      totalStaked += stakedAmount;
    }

    return { activeMiners, totalMiners: accounts.length, totalStaked };
  }

  /** Sum totalClaimed across all past epochs */
  async getTotalMined(currentEpoch: number): Promise<bigint> {
    let totalMined = BigInt(0);
    for (let e = 1; e < currentEpoch; e++) {
      try {
        const es = await this.getEpochState(e);
        totalMined += BigInt((es as any).totalClaimed.toNumber());
      } catch {
        // Epoch state may not exist
      }
    }
    return totalMined;
  }

  // ── TX builders for miner-signed instructions ──────────────────
  // These return serialized unsigned transactions for the miner to sign.

  async buildCommitTx(
    miner: PublicKey,
    marketId: Buffer,
    hash: Buffer
  ): Promise<string> {
    const globalState = await this.getGlobalState();
    const currentEpoch = (globalState as any).currentEpoch.toNumber();

    const [globalStatePda] = pda.findGlobalState(this.config.programId);
    const [epochStatePda] = pda.findEpochState(currentEpoch, this.config.programId);
    const [minerStatePda] = pda.findMinerState(miner, this.config.programId);
    const [commitmentPda] = pda.findCommitment(currentEpoch, miner, marketId, this.config.programId);

    const ix = await this.program.methods
      .commitPrediction(Array.from(marketId), Array.from(hash))
      .accounts({
        globalState: globalStatePda,
        epochState: epochStatePda,
        minerState: minerStatePda,
        commitment: commitmentPda,
        miner,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    return await this.serializeTransaction([ix], miner);
  }

  async buildRevealTx(
    miner: PublicKey,
    epochId: number,
    marketId: Buffer,
    salt: Buffer,
    prediction: number
  ): Promise<string> {
    const [globalStatePda] = pda.findGlobalState(this.config.programId);
    const [epochStatePda] = pda.findEpochState(epochId, this.config.programId);
    const [commitmentPda] = pda.findCommitment(epochId, miner, marketId, this.config.programId);

    const ix = await this.program.methods
      .revealPrediction(
        new BN(epochId),
        Array.from(marketId),
        Array.from(salt),
        prediction
      )
      .accounts({
        globalState: globalStatePda,
        epochState: epochStatePda,
        commitment: commitmentPda,
        miner,
      })
      .instruction();

    return await this.serializeTransaction([ix], miner);
  }

  async buildStakeTx(miner: PublicKey, amount: bigint, minerTokenAccount: PublicKey): Promise<string> {
    const [globalStatePda] = pda.findGlobalState(this.config.programId);
    const [minerStatePda] = pda.findMinerState(miner, this.config.programId);
    const [vaultPda] = pda.findVault(this.config.programId);

    const ix = await this.program.methods
      .stake(new BN(amount.toString()))
      .accounts({
        globalState: globalStatePda,
        minerState: minerStatePda,
        vault: vaultPda,
        minerTokenAccount,
        miner,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    return await this.serializeTransaction([ix], miner);
  }

  async buildUnstakeTx(miner: PublicKey): Promise<string> {
    const [minerStatePda] = pda.findMinerState(miner, this.config.programId);

    const ix = await this.program.methods
      .unstake()
      .accounts({
        minerState: minerStatePda,
        miner,
      })
      .instruction();

    return await this.serializeTransaction([ix], miner);
  }

  async buildWithdrawTx(miner: PublicKey, minerTokenAccount: PublicKey): Promise<string> {
    const [globalStatePda] = pda.findGlobalState(this.config.programId);
    const [minerStatePda] = pda.findMinerState(miner, this.config.programId);
    const [vaultPda] = pda.findVault(this.config.programId);

    const ix = await this.program.methods
      .withdraw()
      .accounts({
        globalState: globalStatePda,
        minerState: minerStatePda,
        vault: vaultPda,
        minerTokenAccount,
        miner,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    return await this.serializeTransaction([ix], miner);
  }

  async buildClaimTx(miner: PublicKey, epochId: number, minerTokenAccount: PublicKey): Promise<string> {
    const [globalStatePda] = pda.findGlobalState(this.config.programId);
    const [epochStatePda] = pda.findEpochState(epochId, this.config.programId);
    const [minerEpochRecordPda] = pda.findMinerEpochRecord(epochId, miner, this.config.programId);
    const [vaultPda] = pda.findVault(this.config.programId);

    const ix = await this.program.methods
      .claimRewards(new BN(epochId))
      .accounts({
        globalState: globalStatePda,
        epochState: epochStatePda,
        minerEpochRecord: minerEpochRecordPda,
        vault: vaultPda,
        minerTokenAccount,
        miner,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    return await this.serializeTransaction([ix], miner);
  }

  async buildCloseCommitmentTx(
    miner: PublicKey,
    epochId: number,
    marketId: Buffer
  ): Promise<string> {
    const [commitmentPda] = pda.findCommitment(epochId, miner, marketId, this.config.programId);
    const [minerEpochRecordPda] = pda.findMinerEpochRecord(epochId, miner, this.config.programId);

    const ix = await this.program.methods
      .closeCommitment(new BN(epochId), Array.from(marketId))
      .accounts({
        commitment: commitmentPda,
        minerEpochRecord: minerEpochRecordPda,
        miner,
      })
      .instruction();

    return await this.serializeTransaction([ix], miner);
  }

  // ── Admin operations (coordinator signs and submits) ────────────

  async advanceEpoch(marketCount: number): Promise<string> {
    const globalState = await this.getGlobalState();
    const currentEpoch = (globalState as any).currentEpoch.toNumber();

    const [globalStatePda] = pda.findGlobalState(this.config.programId);
    const [currentEpochStatePda] = pda.findEpochState(currentEpoch, this.config.programId);
    const [newEpochStatePda] = pda.findEpochState(currentEpoch + 1, this.config.programId);

    const txSig = await this.program.methods
      .advanceEpoch(marketCount)
      .accounts({
        globalState: globalStatePda,
        currentEpochState: currentEpochStatePda,
        newEpochState: newEpochStatePda,
        admin: this.config.adminKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([this.config.adminKeypair])
      .rpc();

    return txSig;
  }

  async scoreMiner(epochId: number, miner: PublicKey, credits: number): Promise<string> {
    const [globalStatePda] = pda.findGlobalState(this.config.programId);
    const [epochStatePda] = pda.findEpochState(epochId, this.config.programId);
    const [minerEpochRecordPda] = pda.findMinerEpochRecord(epochId, miner, this.config.programId);

    const txSig = await this.program.methods
      .scoreMiner(new BN(epochId), new BN(credits))
      .accounts({
        globalState: globalStatePda,
        epochState: epochStatePda,
        minerEpochRecord: minerEpochRecordPda,
        miner,
        admin: this.config.adminKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([this.config.adminKeypair])
      .rpc();

    return txSig;
  }

  async fundEpoch(epochId: number, amount: bigint): Promise<string> {
    const [globalStatePda] = pda.findGlobalState(this.config.programId);
    const [epochStatePda] = pda.findEpochState(epochId, this.config.programId);
    const [vaultPda] = pda.findVault(this.config.programId);

    const txSig = await this.program.methods
      .fundEpoch(new BN(epochId), new BN(amount.toString()))
      .accounts({
        globalState: globalStatePda,
        epochState: epochStatePda,
        vault: vaultPda,
        adminTokenAccount: this.config.adminTokenAccount,
        admin: this.config.adminKeypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([this.config.adminKeypair])
      .rpc();

    return txSig;
  }

  // ── Helpers ────────────────────────────────────────────────────

  private async serializeTransaction(
    instructions: anchor.web3.TransactionInstruction[],
    feePayer: PublicKey
  ): Promise<string> {
    // Retry getLatestBlockhash — devnet RPC can be flaky
    let blockhash: string;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await this.connection.getLatestBlockhash("confirmed");
        blockhash = result.blockhash;
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }

    const tx = new Transaction({
      recentBlockhash: blockhash!,
      feePayer,
    });
    tx.add(...instructions);

    // Return base64-encoded unsigned transaction
    return tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
  }
}
