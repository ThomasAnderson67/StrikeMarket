use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

use crate::error::StrikeError;
use crate::state::*;

// ── Commit Prediction ──────────────────────────────────────────────────
//
// Data flow:
//   Miner generates prediction → hashes with salt → commits hash on-chain
//
// Hash construction:
//   SHA256(salt[32] + miner_pubkey[32] + epoch_id[8] + market_id[32] + prediction[1])

#[derive(Accounts)]
#[instruction(market_id: [u8; 32], hash: [u8; 32])]
pub struct CommitPrediction<'info> {
    #[account(
        seeds = [b"global"],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        seeds = [b"epoch", global_state.current_epoch.to_le_bytes().as_ref()],
        bump = epoch_state.bump,
    )]
    pub epoch_state: Account<'info, EpochState>,

    #[account(
        seeds = [b"miner", miner.key().as_ref()],
        bump = miner_state.bump,
        has_one = miner,
    )]
    pub miner_state: Account<'info, MinerState>,

    #[account(
        init,
        payer = miner,
        space = 8 + Commitment::INIT_SPACE,
        seeds = [
            b"commitment",
            global_state.current_epoch.to_le_bytes().as_ref(),
            miner.key().as_ref(),
            market_id.as_ref(),
        ],
        bump,
    )]
    pub commitment: Account<'info, Commitment>,

    #[account(mut)]
    pub miner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn commit_handler(
    ctx: Context<CommitPrediction>,
    market_id: [u8; 32],
    hash: [u8; 32],
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let epoch_state = &ctx.accounts.epoch_state;
    let global_state = &ctx.accounts.global_state;
    let miner_state = &ctx.accounts.miner_state;

    // Timing: commit window is [epoch_start, epoch_start + commit_end_offset)
    require!(
        now >= epoch_state.epoch_start
            && now < epoch_state.epoch_start + global_state.commit_end_offset,
        StrikeError::CommitWindowClosed
    );

    // Eligibility: must be staked at tier >= 1, no pending unstake
    require!(miner_state.tier >= 1, StrikeError::NotEligible);
    require!(
        miner_state.unstake_requested_at == 0,
        StrikeError::UnstakePending
    );

    let commitment = &mut ctx.accounts.commitment;
    commitment.miner = ctx.accounts.miner.key();
    commitment.epoch = global_state.current_epoch;
    commitment.market_id = market_id;
    commitment.hash = hash;
    commitment.revealed = false;
    commitment.prediction = 0;
    commitment.bump = ctx.bumps.commitment;

    msg!(
        "Committed prediction for epoch {} market {:?}",
        global_state.current_epoch,
        &market_id[..4]
    );
    Ok(())
}

// ── Reveal Prediction ──────────────────────────────────────────────────
//
// Verifies: SHA256(salt + miner + epoch + market_id + prediction) == stored hash
// Prediction: 1=NO, 2=YES

#[derive(Accounts)]
#[instruction(epoch_id: u64, market_id: [u8; 32], salt: [u8; 32], prediction: u8)]
pub struct RevealPrediction<'info> {
    #[account(
        seeds = [b"global"],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        seeds = [b"epoch", epoch_id.to_le_bytes().as_ref()],
        bump = epoch_state.bump,
    )]
    pub epoch_state: Account<'info, EpochState>,

    #[account(
        mut,
        seeds = [
            b"commitment",
            epoch_id.to_le_bytes().as_ref(),
            miner.key().as_ref(),
            market_id.as_ref(),
        ],
        bump = commitment.bump,
        has_one = miner,
    )]
    pub commitment: Account<'info, Commitment>,

    pub miner: Signer<'info>,
}

pub fn reveal_handler(
    ctx: Context<RevealPrediction>,
    epoch_id: u64,
    _market_id: [u8; 32],
    salt: [u8; 32],
    prediction: u8,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let epoch_state = &ctx.accounts.epoch_state;
    let global_state = &ctx.accounts.global_state;
    let commitment = &mut ctx.accounts.commitment;

    // Timing: reveal window is [epoch_start + reveal_start_offset, epoch_start + reveal_end_offset)
    require!(
        now >= epoch_state.epoch_start + global_state.reveal_start_offset
            && now < epoch_state.epoch_start + global_state.reveal_end_offset,
        StrikeError::RevealWindowClosed
    );

    require!(!commitment.revealed, StrikeError::AlreadyRevealed);
    require!(prediction == 1 || prediction == 2, StrikeError::InvalidPrediction);

    // Verify hash: SHA256(salt + miner + epoch + market_id + prediction)
    let computed = hashv(&[
        &salt,
        ctx.accounts.miner.key().as_ref(),
        &epoch_id.to_le_bytes(),
        &commitment.market_id,
        &[prediction],
    ]);
    require!(
        computed.to_bytes() == commitment.hash,
        StrikeError::HashMismatch
    );

    commitment.revealed = true;
    commitment.prediction = prediction;

    msg!(
        "Revealed prediction for epoch {}: {}",
        epoch_id,
        if prediction == 1 { "NO" } else { "YES" }
    );
    Ok(())
}
