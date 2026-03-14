import { Connection, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import { Config } from "../config.js";
import * as pda from "../pda.js";
import idl from "../enelbot.json" with { type: "json" };

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
        new anchor.BN(epochId),
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
      .stake(new anchor.BN(amount.toString()))
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
      .claimRewards(new anchor.BN(epochId))
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
      .closeCommitment(new anchor.BN(epochId), Array.from(marketId))
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
      .scoreMiner(new anchor.BN(epochId), new anchor.BN(credits))
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
      .fundEpoch(new anchor.BN(epochId), new anchor.BN(amount.toString()))
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
    const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({
      recentBlockhash: blockhash,
      feePayer,
    });
    tx.add(...instructions);

    // Return base64-encoded unsigned transaction
    return tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
  }
}
