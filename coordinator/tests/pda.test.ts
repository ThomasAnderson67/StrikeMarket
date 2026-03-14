import { describe, it, expect } from "vitest";
import { PublicKey, Keypair } from "@solana/web3.js";
import { createHash } from "crypto";
import {
  findGlobalState,
  findVault,
  findEpochState,
  findMinerState,
  findCommitment,
  findMinerEpochRecord,
} from "../src/pda.js";

const PROGRAM_ID = new PublicKey("2BewLeJcdz8cmdjo1WvhtNphFoc7wk9V6fXUk5vzb19Q");

describe("PDA derivation", () => {
  it("findGlobalState is deterministic", () => {
    const [addr1] = findGlobalState(PROGRAM_ID);
    const [addr2] = findGlobalState(PROGRAM_ID);
    expect(addr1.equals(addr2)).toBe(true);
  });

  it("findVault is deterministic", () => {
    const [addr1] = findVault(PROGRAM_ID);
    const [addr2] = findVault(PROGRAM_ID);
    expect(addr1.equals(addr2)).toBe(true);
  });

  it("findGlobalState and findVault produce different addresses", () => {
    const [global] = findGlobalState(PROGRAM_ID);
    const [vault] = findVault(PROGRAM_ID);
    expect(global.equals(vault)).toBe(false);
  });

  it("findEpochState produces different addresses for different epochs", () => {
    const [epoch1] = findEpochState(1, PROGRAM_ID);
    const [epoch2] = findEpochState(2, PROGRAM_ID);
    expect(epoch1.equals(epoch2)).toBe(false);
  });

  it("findEpochState is deterministic for same epoch", () => {
    const [addr1] = findEpochState(42, PROGRAM_ID);
    const [addr2] = findEpochState(42, PROGRAM_ID);
    expect(addr1.equals(addr2)).toBe(true);
  });

  it("findMinerState produces different addresses for different miners", () => {
    const miner1 = Keypair.generate().publicKey;
    const miner2 = Keypair.generate().publicKey;
    const [addr1] = findMinerState(miner1, PROGRAM_ID);
    const [addr2] = findMinerState(miner2, PROGRAM_ID);
    expect(addr1.equals(addr2)).toBe(false);
  });

  it("findCommitment uses all seeds to derive unique address", () => {
    const miner = Keypair.generate().publicKey;
    const marketId1 = createHash("sha256").update("market-1").digest();
    const marketId2 = createHash("sha256").update("market-2").digest();

    const [addr1] = findCommitment(1, miner, marketId1, PROGRAM_ID);
    const [addr2] = findCommitment(1, miner, marketId2, PROGRAM_ID);
    expect(addr1.equals(addr2)).toBe(false);

    // Different epoch, same market
    const [addr3] = findCommitment(2, miner, marketId1, PROGRAM_ID);
    expect(addr1.equals(addr3)).toBe(false);
  });

  it("findMinerEpochRecord differs by epoch and miner", () => {
    const miner1 = Keypair.generate().publicKey;
    const miner2 = Keypair.generate().publicKey;

    const [a] = findMinerEpochRecord(1, miner1, PROGRAM_ID);
    const [b] = findMinerEpochRecord(2, miner1, PROGRAM_ID);
    const [c] = findMinerEpochRecord(1, miner2, PROGRAM_ID);

    expect(a.equals(b)).toBe(false);
    expect(a.equals(c)).toBe(false);
    expect(b.equals(c)).toBe(false);
  });

  it("all PDAs are valid PublicKeys (on the ed25519 curve or off-curve)", () => {
    const miner = Keypair.generate().publicKey;
    const marketId = Buffer.alloc(32, 0xff);

    const pdas = [
      findGlobalState(PROGRAM_ID),
      findVault(PROGRAM_ID),
      findEpochState(1, PROGRAM_ID),
      findMinerState(miner, PROGRAM_ID),
      findCommitment(1, miner, marketId, PROGRAM_ID),
      findMinerEpochRecord(1, miner, PROGRAM_ID),
    ];

    for (const [addr, bump] of pdas) {
      expect(addr).toBeInstanceOf(PublicKey);
      expect(bump).toBeGreaterThanOrEqual(0);
      expect(bump).toBeLessThanOrEqual(255);
    }
  });
});
