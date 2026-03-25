use anchor_lang::prelude::*;
use anchor_spl::token_interface::{TokenInterface, TokenAccount, Mint};

use crate::state::*;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct InitializeParams {
    pub epoch_duration: i64,
    pub commit_end_offset: i64,
    pub reveal_start_offset: i64,
    pub reveal_end_offset: i64,
    pub market_count: u16,
    pub mining_fee_bps: u16,       // mining fee in basis points (100 = 1%)
}

#[derive(Accounts)]
#[instruction(params: InitializeParams)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + GlobalState::INIT_SPACE,
        seeds = [b"global"],
        bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    #[account(
        init,
        payer = admin,
        space = 8 + EpochState::INIT_SPACE,
        seeds = [b"epoch", 1u64.to_le_bytes().as_ref()],
        bump,
    )]
    pub epoch_state: Account<'info, EpochState>,

    #[account(
        init,
        payer = admin,
        seeds = [b"vault"],
        bump,
        token::mint = strk_mint,
        token::authority = global_state,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    pub strk_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    let global_state = &mut ctx.accounts.global_state;
    global_state.admin = ctx.accounts.admin.key();
    global_state.strk_mint = ctx.accounts.strk_mint.key();
    global_state.current_epoch = 1;
    global_state.epoch_duration = params.epoch_duration;
    global_state.commit_end_offset = params.commit_end_offset;
    global_state.reveal_start_offset = params.reveal_start_offset;
    global_state.reveal_end_offset = params.reveal_end_offset;
    global_state.mining_fee_bps = params.mining_fee_bps;
    global_state.bump = ctx.bumps.global_state;

    let epoch_state = &mut ctx.accounts.epoch_state;
    epoch_state.epoch_id = 1;
    epoch_state.epoch_start = now;
    epoch_state.total_credits = 0;
    epoch_state.funded = false;
    epoch_state.reward_amount = 0;
    epoch_state.total_claimed = 0;
    epoch_state.market_count = params.market_count;
    epoch_state.bump = ctx.bumps.epoch_state;

    msg!("Strike initialized. Epoch 1 started at {}", now);
    Ok(())
}
