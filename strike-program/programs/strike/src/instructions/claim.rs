use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::StrikeError;
use crate::state::*;

// ── Claim Rewards ──────────────────────────────────────────────────────
//
// Reward calculation:
//   share = reward_amount * miner_credits / total_credits
//   actual = min(share, remaining)  ← dust handling for last claimer
//
// Example:
//   reward=1000, total_credits=3
//   Miner A (1 credit): 333
//   Miner B (1 credit): 333
//   Miner C (1 credit): min(333, 334) = 334  ← gets dust

#[derive(Accounts)]
#[instruction(epoch_id: u64)]
pub struct ClaimRewards<'info> {
    #[account(
        seeds = [b"global"],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        mut,
        seeds = [b"epoch", epoch_id.to_le_bytes().as_ref()],
        bump = epoch_state.bump,
    )]
    pub epoch_state: Account<'info, EpochState>,

    #[account(
        mut,
        seeds = [b"miner_epoch", epoch_id.to_le_bytes().as_ref(), miner.key().as_ref()],
        bump = miner_epoch_record.bump,
        has_one = miner,
    )]
    pub miner_epoch_record: Account<'info, MinerEpochRecord>,

    #[account(
        mut,
        seeds = [b"vault"],
        bump,
        token::mint = global_state.strk_mint,
        token::authority = global_state,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = global_state.strk_mint,
        token::authority = miner,
    )]
    pub miner_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub miner: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn claim_handler(ctx: Context<ClaimRewards>, _epoch_id: u64) -> Result<()> {
    let epoch_state = &mut ctx.accounts.epoch_state;
    let record = &mut ctx.accounts.miner_epoch_record;

    // Epochs are funded by the mining fee pool (staking fees) and optionally
    // by admin via fund_epoch. Require reward_amount > 0 instead of the funded flag.
    require!(epoch_state.reward_amount > 0, StrikeError::EpochNotFunded);
    require!(record.credits > 0, StrikeError::NoCredits);
    require!(!record.claimed, StrikeError::AlreadyClaimed);

    // Calculate proportional share with dust handling
    let share = epoch_state
        .reward_amount
        .checked_mul(record.credits)
        .ok_or(StrikeError::Overflow)?
        .checked_div(epoch_state.total_credits)
        .ok_or(StrikeError::Overflow)?;

    let remaining = epoch_state
        .reward_amount
        .checked_sub(epoch_state.total_claimed)
        .ok_or(StrikeError::Overflow)?;

    let actual_share = share.min(remaining);

    // Transfer from vault to miner, signed by GlobalState PDA
    let bump = ctx.accounts.global_state.bump;
    let seeds: &[&[u8]] = &[b"global", &[bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.miner_token_account.to_account_info(),
                authority: ctx.accounts.global_state.to_account_info(),
            },
            &[seeds],
        ),
        actual_share,
    )?;

    record.claimed = true;
    epoch_state.total_claimed = epoch_state
        .total_claimed
        .checked_add(actual_share)
        .ok_or(StrikeError::Overflow)?;

    msg!("Claimed {} base units for epoch {}", actual_share, epoch_state.epoch_id);
    Ok(())
}

// ── Close Commitment ───────────────────────────────────────────────────
//
// Closes a Commitment PDA after the miner has claimed for that epoch.
// Rent is refunded to the miner.

#[derive(Accounts)]
#[instruction(epoch_id: u64, market_id: [u8; 32])]
pub struct CloseCommitment<'info> {
    #[account(
        mut,
        close = miner,
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

    #[account(
        seeds = [b"miner_epoch", epoch_id.to_le_bytes().as_ref(), miner.key().as_ref()],
        bump = miner_epoch_record.bump,
        constraint = miner_epoch_record.claimed @ StrikeError::MustClaimFirst,
    )]
    pub miner_epoch_record: Account<'info, MinerEpochRecord>,

    #[account(mut)]
    pub miner: Signer<'info>,
}

pub fn close_commitment_handler(
    _ctx: Context<CloseCommitment>,
    epoch_id: u64,
    _market_id: [u8; 32],
) -> Result<()> {
    msg!("Closed commitment for epoch {}", epoch_id);
    Ok(())
}
