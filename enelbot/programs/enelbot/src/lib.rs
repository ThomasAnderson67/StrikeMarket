use anchor_lang::prelude::*;

mod error;
mod instructions;
mod state;

use instructions::*;

declare_id!("44aVv3wfjoCsUbcRNym8CQuTLtRW36Msq4DWEnZzYmSg");

#[program]
pub mod enelbot {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
        instructions::initialize::handler(ctx, params)
    }

    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        instructions::stake::stake_handler(ctx, amount)
    }

    pub fn unstake(ctx: Context<Unstake>) -> Result<()> {
        instructions::stake::unstake_handler(ctx)
    }

    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        instructions::stake::withdraw_handler(ctx)
    }

    pub fn commit_prediction(
        ctx: Context<CommitPrediction>,
        market_id: [u8; 32],
        hash: [u8; 32],
    ) -> Result<()> {
        instructions::prediction::commit_handler(ctx, market_id, hash)
    }

    pub fn reveal_prediction(
        ctx: Context<RevealPrediction>,
        epoch_id: u64,
        market_id: [u8; 32],
        salt: [u8; 32],
        prediction: u8,
    ) -> Result<()> {
        instructions::prediction::reveal_handler(ctx, epoch_id, market_id, salt, prediction)
    }

    pub fn advance_epoch(ctx: Context<AdvanceEpoch>, market_count: u16) -> Result<()> {
        instructions::admin::advance_epoch_handler(ctx, market_count)
    }

    pub fn score_miner(ctx: Context<ScoreMiner>, epoch_id: u64, credits: u64) -> Result<()> {
        instructions::admin::score_miner_handler(ctx, epoch_id, credits)
    }

    pub fn fund_epoch(ctx: Context<FundEpoch>, epoch_id: u64, amount: u64) -> Result<()> {
        instructions::admin::fund_epoch_handler(ctx, epoch_id, amount)
    }

    pub fn claim_rewards(ctx: Context<ClaimRewards>, epoch_id: u64) -> Result<()> {
        instructions::claim::claim_handler(ctx, epoch_id)
    }

    pub fn close_commitment(
        ctx: Context<CloseCommitment>,
        epoch_id: u64,
        market_id: [u8; 32],
    ) -> Result<()> {
        instructions::claim::close_commitment_handler(ctx, epoch_id, market_id)
    }
}
