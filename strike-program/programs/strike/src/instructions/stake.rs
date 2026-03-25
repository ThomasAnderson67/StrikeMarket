use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, TokenInterface, TokenAccount, Transfer};

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
        mut,
        seeds = [b"epoch", global_state.current_epoch.to_le_bytes().as_ref()],
        bump = epoch_state.bump,
    )]
    pub epoch_state: Account<'info, EpochState>,

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
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = global_state.strk_mint,
        token::authority = miner,
    )]
    pub miner_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub miner: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
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

    // Calculate mining fee and net stake amount
    let fee_bps = ctx.accounts.global_state.mining_fee_bps as u64;
    let fee = amount
        .checked_mul(fee_bps)
        .ok_or(StrikeError::Overflow)?
        .checked_div(10000)
        .ok_or(StrikeError::Overflow)?;
    let net_amount = amount
        .checked_sub(fee)
        .ok_or(StrikeError::Overflow)?;

    // Transfer full amount from miner to vault
    token_interface::transfer(
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

    // Record only the net amount as staked (fee goes to reward pool)
    miner_state.staked_amount = miner_state
        .staked_amount
        .checked_add(net_amount)
        .ok_or(StrikeError::Overflow)?;

    let new_tier = calculate_tier(miner_state.staked_amount);
    require!(new_tier >= 1, StrikeError::InsufficientStake);
    miner_state.tier = new_tier;

    // Add fee to current epoch's reward pool
    let epoch_state = &mut ctx.accounts.epoch_state;
    epoch_state.reward_amount = epoch_state
        .reward_amount
        .checked_add(fee)
        .ok_or(StrikeError::Overflow)?;

    msg!(
        "Staked {} base units (fee: {}, net: {}). Total: {}. Tier: {}. Epoch {} reward pool: {}",
        amount,
        fee,
        net_amount,
        miner_state.staked_amount,
        miner_state.tier,
        epoch_state.epoch_id,
        epoch_state.reward_amount
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
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = global_state.strk_mint,
        token::authority = miner,
    )]
    pub miner_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub miner: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
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
    token_interface::transfer(
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
