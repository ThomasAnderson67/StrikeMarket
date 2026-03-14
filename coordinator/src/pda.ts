import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

// ── PDA derivation (must match program seeds exactly) ──────────────────
//
// Program PDA map:
//   GlobalState:     ["global"]
//   Vault:           ["vault"]
//   EpochState:      ["epoch", epoch_id.to_le_bytes()]
//   MinerState:      ["miner", miner_pubkey]
//   Commitment:      ["commitment", epoch_id.to_le_bytes(), miner_pubkey, market_id]
//   MinerEpochRecord: ["miner_epoch", epoch_id.to_le_bytes(), miner_pubkey]

function epochIdBuffer(epochId: number | BN): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(epochId.toString()));
  return buf;
}

export function findGlobalState(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("global")], programId);
}

export function findVault(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("vault")], programId);
}

export function findEpochState(
  epochId: number | BN,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("epoch"), epochIdBuffer(epochId)],
    programId
  );
}

export function findMinerState(
  miner: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("miner"), miner.toBuffer()],
    programId
  );
}

export function findCommitment(
  epochId: number | BN,
  miner: PublicKey,
  marketId: Buffer,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("commitment"), epochIdBuffer(epochId), miner.toBuffer(), marketId],
    programId
  );
}

export function findMinerEpochRecord(
  epochId: number | BN,
  miner: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("miner_epoch"), epochIdBuffer(epochId), miner.toBuffer()],
    programId
  );
}
