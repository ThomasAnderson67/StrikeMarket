use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::EnelbotError;
use crate::state::*;

// ── Advance Epoch ──────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(market_count: u16)]
pub struct AdvanceEpoch<'info> {
    #[account(
        mut,
        seeds = [b"global"],
        bump = global_state.bump,
        has_one = admin,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        seeds = [b"epoch", global_state.current_epoch.to_le_bytes().as_ref()],
        bump = current_epoch_state.bump,
    )]
    pub current_epoch_state: Account<'info, EpochState>,

    #[account(
        init,
        payer = admin,
        space = 8 + EpochState::INIT_SPACE,
        seeds = [b"epoch", (global_state.current_epoch + 1).to_le_bytes().as_ref()],
        bump,
    )]
    pub new_epoch_state: Account<'info, EpochState>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn advance_epoch_handler(ctx: Context<AdvanceEpoch>, market_count: u16) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let global_state = &ctx.accounts.global_state;
    let current_epoch = &ctx.accounts.current_epoch_state;

    // Current epoch must have ended
    require!(
        now >= current_epoch.epoch_start + global_state.epoch_duration,
        EnelbotError::EpochNotEnded
    );

    let new_epoch_id = global_state.current_epoch + 1;

    let new_epoch = &mut ctx.accounts.new_epoch_state;
    new_epoch.epoch_id = new_epoch_id;
    new_epoch.epoch_start = now;
    new_epoch.total_credits = 0;
    new_epoch.funded = false;
    new_epoch.reward_amount = 0;
    new_epoch.total_claimed = 0;
    new_epoch.market_count = market_count;
    new_epoch.bump = ctx.bumps.new_epoch_state;

    let global_state = &mut ctx.accounts.global_state;
    global_state.current_epoch = new_epoch_id;

    msg!("Advanced to epoch {}. {} markets.", new_epoch_id, market_count);
    Ok(())
}

// ── Score Miner ────────────────────────────────────────────────────────
//
// Called by coordinator after reveal window closes. Creates a
// MinerEpochRecord with the miner's credits for the epoch.
//
// On-chain guard: credits <= market_count * MAX_TIER_MULTIPLIER

#[derive(Accounts)]
#[instruction(epoch_id: u64, credits: u64)]
pub struct ScoreMiner<'info> {
    #[account(
        seeds = [b"global"],
        bump = global_state.bump,
        has_one = admin,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        mut,
        seeds = [b"epoch", epoch_id.to_le_bytes().as_ref()],
        bump = epoch_state.bump,
    )]
    pub epoch_state: Account<'info, EpochState>,

    #[account(
        init,
        payer = admin,
        space = 8 + MinerEpochRecord::INIT_SPACE,
        seeds = [b"miner_epoch", epoch_id.to_le_bytes().as_ref(), miner.key().as_ref()],
        bump,
    )]
    pub miner_epoch_record: Account<'info, MinerEpochRecord>,

    /// CHECK: Miner public key, used only for PDA derivation. Not validated further
    /// because the coordinator (admin) is trusted to score valid miners.
    pub miner: UncheckedAccount<'info>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn score_miner_handler(ctx: Context<ScoreMiner>, epoch_id: u64, credits: u64) -> Result<()> {
    let epoch_state = &mut ctx.accounts.epoch_state;

    // Guard: credits cannot exceed theoretical maximum
    let max_credits = (epoch_state.market_count as u64)
        .checked_mul(MAX_TIER_MULTIPLIER)
        .ok_or(EnelbotError::Overflow)?;
    require!(credits <= max_credits, EnelbotError::InvalidCredits);

    let record = &mut ctx.accounts.miner_epoch_record;
    record.miner = ctx.accounts.miner.key();
    record.epoch = epoch_id;
    record.credits = credits;
    record.claimed = false;
    record.bump = ctx.bumps.miner_epoch_record;

    epoch_state.total_credits = epoch_state
        .total_credits
        .checked_add(credits)
        .ok_or(EnelbotError::Overflow)?;

    msg!(
        "Scored miner {} for epoch {}: {} credits",
        ctx.accounts.miner.key(),
        epoch_id,
        credits
    );
    Ok(())
}

// ── Fund Epoch ─────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(epoch_id: u64, amount: u64)]
pub struct FundEpoch<'info> {
    #[account(
        seeds = [b"global"],
        bump = global_state.bump,
        has_one = admin,
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
        seeds = [b"vault"],
        bump,
        token::mint = global_state.enel_mint,
        token::authority = global_state,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = global_state.enel_mint,
        token::authority = admin,
    )]
    pub admin_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn fund_epoch_handler(ctx: Context<FundEpoch>, _epoch_id: u64, amount: u64) -> Result<()> {
    let epoch_state = &mut ctx.accounts.epoch_state;

    require!(!epoch_state.funded, EnelbotError::AlreadyFunded);

    // Transfer reward tokens to vault
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.admin_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.admin.to_account_info(),
            },
        ),
        amount,
    )?;

    epoch_state.funded = true;
    epoch_state.reward_amount = amount;

    msg!("Funded epoch {} with {} base units", epoch_state.epoch_id, amount);
    Ok(())
}
