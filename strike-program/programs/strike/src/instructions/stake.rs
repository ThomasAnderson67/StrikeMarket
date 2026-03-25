use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::StrikeError;
use crate::state::*;

// ── Stake ──────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(
        seeds = [b"global"],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        init_if_needed,
        payer = miner,
        space = 8 + MinerState::INIT_SPACE,
        seeds = [b"miner", miner.key().as_ref()],
        bump,
    )]
    pub miner_state: Account<'info, MinerState>,

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
    pub system_program: Program<'info, System>,
}

pub fn stake_handler(ctx: Context<Stake>, amount: u64) -> Result<()> {
    let miner_state = &mut ctx.accounts.miner_state;

    // First-time init: set miner pubkey and bump
    if miner_state.miner == Pubkey::default() {
        miner_state.miner = ctx.accounts.miner.key();
        miner_state.bump = ctx.bumps.miner_state;
    }

    require!(
        miner_state.unstake_requested_at == 0,
        StrikeError::UnstakePending
    );

    // Transfer tokens to vault
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.miner_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.miner.to_account_info(),
            },
        ),
        amount,
    )?;

    miner_state.staked_amount = miner_state
        .staked_amount
        .checked_add(amount)
        .ok_or(StrikeError::Overflow)?;

    let new_tier = calculate_tier(miner_state.staked_amount);
    require!(new_tier >= 1, StrikeError::InsufficientStake);
    miner_state.tier = new_tier;

    msg!(
        "Staked {} base units. Total: {}. Tier: {}",
        amount,
        miner_state.staked_amount,
        miner_state.tier
    );
    Ok(())
}

// ── Unstake ────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(
        mut,
        seeds = [b"miner", miner.key().as_ref()],
        bump = miner_state.bump,
        has_one = miner,
    )]
    pub miner_state: Account<'info, MinerState>,

    pub miner: Signer<'info>,
}

pub fn unstake_handler(ctx: Context<Unstake>) -> Result<()> {
    let miner_state = &mut ctx.accounts.miner_state;

    require!(miner_state.staked_amount > 0, StrikeError::NothingStaked);
    require!(
        miner_state.unstake_requested_at == 0,
        StrikeError::AlreadyUnstaking
    );

    let now = Clock::get()?.unix_timestamp;
    miner_state.unstake_requested_at = now;
    miner_state.tier = 0; // Immediately lose mining eligibility

    msg!("Unstake requested. Cooldown ends at {}", now + COOLDOWN_SECONDS);
    Ok(())
}

// ── Withdraw ───────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        seeds = [b"global"],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        mut,
        seeds = [b"miner", miner.key().as_ref()],
        bump = miner_state.bump,
        has_one = miner,
    )]
    pub miner_state: Account<'info, MinerState>,

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

pub fn withdraw_handler(ctx: Context<Withdraw>) -> Result<()> {
    let miner_state = &mut ctx.accounts.miner_state;

    require!(
        miner_state.unstake_requested_at > 0,
        StrikeError::NoUnstakePending
    );

    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= miner_state.unstake_requested_at + COOLDOWN_SECONDS,
        StrikeError::CooldownNotElapsed
    );

    let amount = miner_state.staked_amount;

    // Transfer tokens back to miner, signed by GlobalState PDA
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
        amount,
    )?;

    // Reset miner state
    miner_state.staked_amount = 0;
    miner_state.tier = 0;
    miner_state.unstake_requested_at = 0;

    msg!("Withdrew {} base units", amount);
    Ok(())
}
