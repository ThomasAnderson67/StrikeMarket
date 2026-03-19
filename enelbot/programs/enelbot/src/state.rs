use anchor_lang::prelude::*;

// Pump.fun tokens on Solana typically use 6 decimals
pub const TOKEN_DECIMALS: u32 = 6;
pub const TIER_1_MINIMUM: u64 = 1_000_000 * 10u64.pow(TOKEN_DECIMALS);   // 1M $STRK
pub const TIER_2_MINIMUM: u64 = 10_000_000 * 10u64.pow(TOKEN_DECIMALS);  // 10M $STRK
pub const TIER_3_MINIMUM: u64 = 100_000_000 * 10u64.pow(TOKEN_DECIMALS); // 100M $STRK
pub const MAX_TIER_MULTIPLIER: u64 = 3;
pub const COOLDOWN_SECONDS: i64 = 86400; // 24 hours

pub fn calculate_tier(staked_amount: u64) -> u8 {
    if staked_amount >= TIER_3_MINIMUM {
        3
    } else if staked_amount >= TIER_2_MINIMUM {
        2
    } else if staked_amount >= TIER_1_MINIMUM {
        1
    } else {
        0
    }
}

#[allow(dead_code)]
pub fn tier_multiplier(tier: u8) -> u64 {
    match tier {
        1 => 1,
        2 => 2,
        3 => 3,
        _ => 0,
    }
}

/// Global configuration, one per program deployment.
/// Seeds: ["global"]
#[account]
#[derive(InitSpace)]
pub struct GlobalState {
    pub admin: Pubkey,
    pub enel_mint: Pubkey,
    pub current_epoch: u64,
    pub epoch_duration: i64,       // seconds (86400 = 24h mainnet)
    pub commit_end_offset: i64,    // seconds from epoch_start (79200 = 22h)
    pub reveal_start_offset: i64,  // seconds from epoch_start (86400 = 24h)
    pub reveal_end_offset: i64,    // seconds from epoch_start (93600 = 26h)
    pub bump: u8,
}

/// Per-epoch state tracking credits, funding, and claims.
/// Seeds: ["epoch", epoch_id.to_le_bytes()]
#[account]
#[derive(InitSpace)]
pub struct EpochState {
    pub epoch_id: u64,
    pub epoch_start: i64,
    pub total_credits: u64,
    pub funded: bool,
    pub reward_amount: u64,
    pub total_claimed: u64,
    pub market_count: u16,
    pub bump: u8,
}

/// Per-miner staking state.
/// Seeds: ["miner", miner_pubkey]
#[account]
#[derive(InitSpace)]
pub struct MinerState {
    pub miner: Pubkey,
    pub staked_amount: u64,
    pub tier: u8,
    pub unstake_requested_at: i64, // 0 = not unstaking
    pub bump: u8,
}

/// Single prediction commitment (one per miner per market per epoch).
/// Seeds: ["commitment", epoch.to_le_bytes(), miner_pubkey, market_id]
///
/// Commit-reveal state machine:
///   COMMITTED ──reveal()──▶ REVEALED ──score()──▶ SCORED
///   (hash set)              (prediction set)      (credits computed off-chain)
#[account]
#[derive(InitSpace)]
pub struct Commitment {
    pub miner: Pubkey,
    pub epoch: u64,
    pub market_id: [u8; 32],
    pub hash: [u8; 32],
    pub revealed: bool,
    pub prediction: u8, // 0=unrevealed, 1=NO, 2=YES
    pub bump: u8,
}

/// Per-miner per-epoch scoring record. Created by coordinator (admin),
/// used by miner to claim rewards.
/// Seeds: ["miner_epoch", epoch_id.to_le_bytes(), miner_pubkey]
#[account]
#[derive(InitSpace)]
pub struct MinerEpochRecord {
    pub miner: Pubkey,
    pub epoch: u64,
    pub credits: u64,
    pub claimed: bool,
    pub bump: u8,
}
