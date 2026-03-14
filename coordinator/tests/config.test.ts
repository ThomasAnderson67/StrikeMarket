import { describe, it, expect } from "vitest";
import {
  calculateTier,
  tierMultiplier,
  TIER_1_MINIMUM,
  TIER_2_MINIMUM,
  TIER_3_MINIMUM,
  TOKEN_DECIMALS,
} from "../src/config.js";

describe("calculateTier", () => {
  it("returns tier 0 for zero stake", () => {
    expect(calculateTier(0n)).toBe(0);
  });

  it("returns tier 0 below tier 1 minimum", () => {
    expect(calculateTier(TIER_1_MINIMUM - 1n)).toBe(0);
  });

  it("returns tier 1 at exact tier 1 minimum", () => {
    expect(calculateTier(TIER_1_MINIMUM)).toBe(1);
  });

  it("returns tier 1 between tier 1 and tier 2", () => {
    expect(calculateTier(TIER_2_MINIMUM - 1n)).toBe(1);
  });

  it("returns tier 2 at exact tier 2 minimum", () => {
    expect(calculateTier(TIER_2_MINIMUM)).toBe(2);
  });

  it("returns tier 2 between tier 2 and tier 3", () => {
    expect(calculateTier(TIER_3_MINIMUM - 1n)).toBe(2);
  });

  it("returns tier 3 at exact tier 3 minimum", () => {
    expect(calculateTier(TIER_3_MINIMUM)).toBe(3);
  });

  it("returns tier 3 above tier 3 minimum", () => {
    expect(calculateTier(TIER_3_MINIMUM * 10n)).toBe(3);
  });
});

describe("tierMultiplier", () => {
  it("returns 0 for tier 0", () => {
    expect(tierMultiplier(0)).toBe(0);
  });

  it("returns 1 for tier 1", () => {
    expect(tierMultiplier(1)).toBe(1);
  });

  it("returns 2 for tier 2", () => {
    expect(tierMultiplier(2)).toBe(2);
  });

  it("returns 3 for tier 3", () => {
    expect(tierMultiplier(3)).toBe(3);
  });

  it("returns 0 for negative tier", () => {
    expect(tierMultiplier(-1)).toBe(0);
  });

  it("returns 0 for tier > 3 (out of range)", () => {
    expect(tierMultiplier(4)).toBe(0);
  });
});

describe("tier constants", () => {
  it("TIER_1_MINIMUM is 1M tokens with correct decimals", () => {
    expect(TIER_1_MINIMUM).toBe(1_000_000n * 10n ** BigInt(TOKEN_DECIMALS));
  });

  it("TIER_2_MINIMUM is 10M tokens with correct decimals", () => {
    expect(TIER_2_MINIMUM).toBe(10_000_000n * 10n ** BigInt(TOKEN_DECIMALS));
  });

  it("TIER_3_MINIMUM is 100M tokens with correct decimals", () => {
    expect(TIER_3_MINIMUM).toBe(100_000_000n * 10n ** BigInt(TOKEN_DECIMALS));
  });

  it("tier minimums are in ascending order", () => {
    expect(TIER_1_MINIMUM < TIER_2_MINIMUM).toBe(true);
    expect(TIER_2_MINIMUM < TIER_3_MINIMUM).toBe(true);
  });
});
