use anchor_lang::prelude::*;

#[error_code]
pub enum StrikeError {
    #[msg("Insufficient stake for minimum tier")]
    InsufficientStake,
    #[msg("Cannot stake while unstake is pending")]
    UnstakePending,
    #[msg("Nothing staked")]
    NothingStaked,
    #[msg("Already unstaking")]
    AlreadyUnstaking,
    #[msg("No unstake pending")]
    NoUnstakePending,
    #[msg("Cooldown period has not elapsed")]
    CooldownNotElapsed,
    #[msg("Commit window is not open")]
    CommitWindowClosed,
    #[msg("Not eligible to mine")]
    NotEligible,
    #[msg("Reveal window is not open")]
    RevealWindowClosed,
    #[msg("Hash mismatch on reveal")]
    HashMismatch,
    #[msg("Commitment already revealed")]
    AlreadyRevealed,
    #[msg("Invalid prediction value (must be 1=NO or 2=YES)")]
    InvalidPrediction,
    #[msg("Credits exceed maximum for market count and tier")]
    InvalidCredits,
    #[msg("Epoch has not ended yet")]
    EpochNotEnded,
    #[msg("Epoch already funded")]
    AlreadyFunded,
    #[msg("Epoch not funded yet")]
    EpochNotFunded,
    #[msg("No credits for this epoch")]
    NoCredits,
    #[msg("Already claimed for this epoch")]
    AlreadyClaimed,
    #[msg("Must claim rewards before closing commitments")]
    MustClaimFirst,
    #[msg("Arithmetic overflow")]
    Overflow,
}
