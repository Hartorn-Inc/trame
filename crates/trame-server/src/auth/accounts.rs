//! ============================================================================
//! INSTANCE ROLES, OWNER BOOTSTRAP & CAMPAIGN INVITE STORAGE (accounts.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Defines the account-level domain of ADR-0039: the instance-wide
//! `InstanceRole` carried by every account, the single-use owner bootstrap
//! token, the bounded `CampaignInvite` with its `InviteRedemption` records,
//! and the persisted instance id. `AccountStore` is the storage contract;
//! this module implements it in memory (dev and tests), and
//! `storage/postgres_accounts.rs` implements it on PostgreSQL.
//!
//! Without these records anyone reaching the server could register, create
//! campaigns, and reuse a leaked invite link forever (SEC7, SEC10).
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Exactly One Owner`:
//!      - `claim_owner` is the only path that writes `InstanceRole::Owner`. It
//!        consumes a valid, unused, unexpired bootstrap token and checks that
//!        no `Owner` exists in the same critical section (in memory: one
//!        mutex; PostgreSQL: one transaction plus a partial unique index).
//!   2. `Hashed Single-Use Tokens`:
//!      - Bootstrap and invite tokens are 256-bit random hex strings; only
//!        their SHA-256 digests are stored. A bootstrap token is consumed by
//!        the first successful claim; minting a new one deletes the previous.
//!   3. `One Unrevoked Invite Per Campaign`:
//!      - `create_campaign_invite` revokes every unrevoked invite of the
//!        campaign before inserting the new one.
//!   4. `Atomic Redemption`:
//!      - `redeem_campaign_invite` re-checks revocation, expiry, and
//!        `use_count < max_uses`, then creates the account (if any), the
//!        `PLAYER` membership, the redemption record, and the use increment
//!        in one critical section, so concurrent redemptions never exceed
//!        `max_uses` and a failed step leaves no partial account.
//!   5. `No Duplicate Membership`:
//!      - An existing member redeeming again gets `already_member = true`;
//!        no use is consumed and the existing role (e.g. `GM`) is kept.
//!   6. `Removal Sticks Per Invite`:
//!      - An account that already redeemed an invite and is no longer a member
//!        (removed by the GM) gets `MemberRemoved`; only a new invite lets it
//!        back in, so removal is not undone by replaying the same link.
//!   7. `Lock Order` (in memory):
//!      - Nested locks are taken in one order everywhere:
//!        `accounts` -> `campaign_members` -> `users` -> `emails` ->
//!        `oauth_identities`. Lookups copy an id and release the first guard
//!        instead of nesting against that order.
//! ============================================================================

use super::magic_link::now_epoch_seconds;
use super::session::{
    AuthState, BoxFuture, CampaignMemberRecord, DEFAULT_SESSION_TTL_SECONDS, InMemorySessionStore,
    SessionError, UserRecord, generate_session_token, hash_session_token,
};
use axum::http::HeaderMap;
use axum::http::header::{HeaderValue, SET_COOKIE};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

/// Maximum `CampaignInvite` lifetime: 7 days in seconds.
pub const MAX_INVITE_TTL_SECONDS: u64 = 7 * 24 * 3600;

/// Default `CampaignInvite` lifetime when the Game Master sends none (the 7-day cap).
pub const DEFAULT_INVITE_TTL_SECONDS: u64 = MAX_INVITE_TTL_SECONDS;

/// Default number of redemptions a `CampaignInvite` accepts.
pub const DEFAULT_INVITE_MAX_USES: u32 = 8;

/// Upper bound accepted for `max_uses` (mirrored by a SQL `CHECK`).
pub const MAX_INVITE_MAX_USES: u32 = 100;

/// Campaign role granted by every `InviteRedemption`.
pub const INVITE_MEMBER_ROLE: &str = "PLAYER";

/// Instance-wide account role, independent of the per-campaign role.
///
/// Serialized as `"OWNER"`, `"HOST"`, `"MEMBER"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum InstanceRole {
    /// The single account that administers the instance and changes `InstanceRole`s.
    Owner,
    /// Trusted account allowed to create campaigns.
    Host,
    /// Default role of every new account: joins campaigns through invites only.
    #[default]
    Member,
}

impl InstanceRole {
    /// Storage and wire label (`"OWNER"`, `"HOST"`, `"MEMBER"`).
    pub fn as_str(self) -> &'static str {
        match self {
            InstanceRole::Owner => "OWNER",
            InstanceRole::Host => "HOST",
            InstanceRole::Member => "MEMBER",
        }
    }

    /// Case-insensitive parse of a label; `None` for anything else.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_uppercase().as_str() {
            "OWNER" => Some(InstanceRole::Owner),
            "HOST" => Some(InstanceRole::Host),
            "MEMBER" => Some(InstanceRole::Member),
            _ => None,
        }
    }

    /// `Host` and `Owner` may create campaigns; `Member` may not.
    pub fn can_create_campaigns(self) -> bool {
        matches!(self, InstanceRole::Owner | InstanceRole::Host)
    }
}

/// Lifecycle state of a `CampaignInvite` at a given instant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InviteStatus {
    /// Redeemable: not revoked, not expired, uses left.
    Active,
    /// `revoked_at` is set (explicit revoke or replaced by a newer invite).
    Revoked,
    /// `now >= expires_at`.
    Expired,
    /// `use_count >= max_uses`.
    Exhausted,
}

/// Persisted `CampaignInvite`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CampaignInviteRecord {
    /// Invite UUID.
    pub id: Uuid,
    /// Campaign the invite grants a `PLAYER` membership in.
    pub campaign_id: Uuid,
    /// SHA-256 hex digest of the raw token; the raw token is never stored.
    pub token_hash: String,
    /// Game Master who minted the invite.
    pub created_by: Uuid,
    /// Creation time (epoch seconds).
    pub created_at: u64,
    /// Expiry (epoch seconds), at most `created_at + MAX_INVITE_TTL_SECONDS`.
    pub expires_at: u64,
    /// Redemptions accepted (`1..=MAX_INVITE_MAX_USES`).
    pub max_uses: u32,
    /// Redemptions consumed so far (`0..=max_uses`).
    pub use_count: u32,
    /// Revocation time (epoch seconds); `None` while unrevoked.
    pub revoked_at: Option<u64>,
}

impl CampaignInviteRecord {
    /// Status at `now` (epoch seconds). Revocation wins over expiry, expiry over exhaustion.
    pub fn status(&self, now: u64) -> InviteStatus {
        if self.revoked_at.is_some() {
            InviteStatus::Revoked
        } else if now >= self.expires_at {
            InviteStatus::Expired
        } else if self.use_count >= self.max_uses {
            InviteStatus::Exhausted
        } else {
            InviteStatus::Active
        }
    }
}

/// One `InviteRedemption`: who joined a campaign through which invite, and when.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InviteRedemptionRecord {
    /// Redeemed invite.
    pub invite_id: Uuid,
    /// Campaign joined.
    pub campaign_id: Uuid,
    /// Account that joined.
    pub user_id: Uuid,
    /// Display name of that account at listing time.
    pub display_name: String,
    /// Redemption time (epoch seconds).
    pub redeemed_at: u64,
}

/// Who redeems an invite.
#[derive(Debug, Clone)]
pub enum InviteRedeemer {
    /// Unauthenticated visitor: this `Member` account is created in the same critical section.
    NewAccount(UserRecord),
    /// Logged-in account: only the membership is added.
    ExistingUser(Uuid),
}

/// Result of a successful `redeem_campaign_invite`.
#[derive(Debug, Clone)]
pub struct InviteRedemptionOutcome {
    /// Invite after the redemption (`use_count` already incremented).
    pub invite: CampaignInviteRecord,
    /// Account holding the membership.
    pub user_id: Uuid,
    /// Membership (the existing one when `already_member`).
    pub member: CampaignMemberRecord,
    /// `true` when the account was already a member: nothing was written.
    pub already_member: bool,
}

/// Why an invite could not be redeemed.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum InviteRedeemError {
    /// No invite has this token digest.
    #[error("invite not found")]
    NotFound,
    /// The invite was revoked or replaced.
    #[error("invite has been revoked")]
    Revoked,
    /// The invite is past `expires_at`.
    #[error("invite has expired")]
    Expired,
    /// `use_count` reached `max_uses`.
    #[error("invite has no uses left")]
    Exhausted,
    /// The new account's email belongs to another account.
    #[error("email already registered")]
    EmailTaken,
    /// The account already redeemed this invite and was later removed from the campaign;
    /// only a new invite from the Game Master lets it back in.
    #[error("removed from this campaign; ask the Game Master for a new invite")]
    MemberRemoved,
    /// Storage failure.
    #[error("storage error: {0}")]
    Storage(String),
}

impl From<InviteStatus> for InviteRedeemError {
    fn from(status: InviteStatus) -> Self {
        match status {
            InviteStatus::Revoked => InviteRedeemError::Revoked,
            InviteStatus::Expired => InviteRedeemError::Expired,
            InviteStatus::Exhausted | InviteStatus::Active => InviteRedeemError::Exhausted,
        }
    }
}

/// Validity of a presented owner bootstrap token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootstrapTokenStatus {
    /// Unused and unexpired.
    Valid,
    /// Unused but past its expiry.
    Expired,
    /// Unknown, already used, or replaced by a newer token.
    Invalid,
}

/// How the owner bootstrap claims the instance.
#[derive(Debug, Clone)]
pub enum OwnerClaim {
    /// Creates this account with `InstanceRole::Owner`.
    NewAccount(UserRecord),
    /// Promotes this existing account (password already verified by the caller).
    ExistingUser(Uuid),
}

/// Why `claim_owner` failed.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum OwnerClaimError {
    /// Token unknown, used, replaced, or expired.
    #[error("invalid or expired setup token")]
    InvalidToken,
    /// An `Owner` already exists.
    #[error("instance already has an owner")]
    OwnerExists,
    /// The new account's email belongs to another account.
    #[error("email already registered")]
    EmailTaken,
    /// Storage failure.
    #[error("storage error: {0}")]
    Storage(String),
}

/// Storage contract for instance roles, owner bootstrap, instance settings, campaign
/// invites, and membership removal. All timestamps are epoch seconds supplied by the caller.
pub trait AccountStore: Send + Sync {
    /// `true` when an account holds `InstanceRole::Owner`.
    fn owner_exists(&self) -> BoxFuture<'_, Result<bool, SessionError>>;

    /// Every real account (system placeholders excluded), oldest first.
    fn list_users(&self) -> BoxFuture<'_, Result<Vec<UserRecord>, SessionError>>;

    /// Sets `role` on `user_id`; `None` when the account does not exist. Callers never
    /// pass `Owner` (only `claim_owner` creates it).
    fn set_instance_role(
        &self,
        user_id: Uuid,
        role: InstanceRole,
    ) -> BoxFuture<'_, Result<Option<UserRecord>, SessionError>>;

    /// Deletes every bootstrap token and stores `token_hash` valid until `expires_at`.
    fn replace_owner_bootstrap_token<'a>(
        &'a self,
        token_hash: &'a str,
        expires_at: u64,
    ) -> BoxFuture<'a, Result<(), SessionError>>;

    /// Reports whether `token_hash` is currently claimable.
    fn owner_bootstrap_token_status<'a>(
        &'a self,
        token_hash: &'a str,
        now: u64,
    ) -> BoxFuture<'a, Result<BootstrapTokenStatus, SessionError>>;

    /// Atomically consumes the token, checks that no `Owner` exists, and creates or promotes
    /// the `Owner` account. Returns the `Owner` record.
    fn claim_owner<'a>(
        &'a self,
        token_hash: &'a str,
        claim: OwnerClaim,
        now: u64,
    ) -> BoxFuture<'a, Result<UserRecord, OwnerClaimError>>;

    /// Returns the persisted instance id, storing `candidate` first when none exists.
    fn load_or_init_instance_id(
        &self,
        candidate: Uuid,
    ) -> BoxFuture<'_, Result<Uuid, SessionError>>;

    /// Revokes every unrevoked invite of `invite.campaign_id` at `invite.created_at`, then
    /// stores `invite`.
    fn create_campaign_invite(
        &self,
        invite: CampaignInviteRecord,
    ) -> BoxFuture<'_, Result<CampaignInviteRecord, SessionError>>;

    /// The unrevoked invite of `campaign_id` (possibly expired or exhausted), if any.
    fn unrevoked_campaign_invite(
        &self,
        campaign_id: Uuid,
    ) -> BoxFuture<'_, Result<Option<CampaignInviteRecord>, SessionError>>;

    /// Revokes the unrevoked invite of `campaign_id` at `now`; returns it, or `None`.
    fn revoke_campaign_invite(
        &self,
        campaign_id: Uuid,
        now: u64,
    ) -> BoxFuture<'_, Result<Option<CampaignInviteRecord>, SessionError>>;

    /// Looks an invite up by token digest.
    fn find_campaign_invite<'a>(
        &'a self,
        token_hash: &'a str,
    ) -> BoxFuture<'a, Result<Option<CampaignInviteRecord>, SessionError>>;

    /// Atomic `InviteRedemption` (see the module banner, invariants 4 and 5).
    fn redeem_campaign_invite<'a>(
        &'a self,
        token_hash: &'a str,
        redeemer: InviteRedeemer,
        now: u64,
    ) -> BoxFuture<'a, Result<InviteRedemptionOutcome, InviteRedeemError>>;

    /// Every redemption of every invite of `campaign_id`, newest first.
    fn list_invite_redemptions(
        &self,
        campaign_id: Uuid,
    ) -> BoxFuture<'_, Result<Vec<InviteRedemptionRecord>, SessionError>>;

    /// Deletes the membership; `false` when there was none.
    fn remove_campaign_member(
        &self,
        campaign_id: Uuid,
        user_id: Uuid,
    ) -> BoxFuture<'_, Result<bool, SessionError>>;
}

/// In-memory account state owned by `InMemorySessionStore`.
#[derive(Debug, Default)]
pub struct InMemoryAccounts {
    /// `(token_hash, expires_at, used)` of the only bootstrap token.
    bootstrap: Option<(String, u64, bool)>,
    instance_id: Option<Uuid>,
    invites: Vec<CampaignInviteRecord>,
    /// `(invite_id, user_id, redeemed_at)`.
    redemptions: Vec<(Uuid, Uuid, u64)>,
}

impl AccountStore for InMemorySessionStore {
    fn owner_exists(&self) -> BoxFuture<'_, Result<bool, SessionError>> {
        Box::pin(async move {
            let users = self.users.read().await;
            Ok(users
                .values()
                .any(|u| u.instance_role == InstanceRole::Owner))
        })
    }

    fn list_users(&self) -> BoxFuture<'_, Result<Vec<UserRecord>, SessionError>> {
        Box::pin(async move {
            let mut list: Vec<UserRecord> = self.users.read().await.values().cloned().collect();
            list.sort_by_key(|u| (u.created_at, u.id));
            Ok(list)
        })
    }

    fn set_instance_role(
        &self,
        user_id: Uuid,
        role: InstanceRole,
    ) -> BoxFuture<'_, Result<Option<UserRecord>, SessionError>> {
        Box::pin(async move {
            let mut users = self.users.write().await;
            Ok(users.get_mut(&user_id).map(|u| {
                u.instance_role = role;
                u.clone()
            }))
        })
    }

    fn replace_owner_bootstrap_token<'a>(
        &'a self,
        token_hash: &'a str,
        expires_at: u64,
    ) -> BoxFuture<'a, Result<(), SessionError>> {
        Box::pin(async move {
            self.accounts.lock().await.bootstrap =
                Some((token_hash.to_string(), expires_at, false));
            Ok(())
        })
    }

    fn owner_bootstrap_token_status<'a>(
        &'a self,
        token_hash: &'a str,
        now: u64,
    ) -> BoxFuture<'a, Result<BootstrapTokenStatus, SessionError>> {
        Box::pin(async move {
            let accounts = self.accounts.lock().await;
            Ok(match &accounts.bootstrap {
                Some((hash, _, false)) if hash != token_hash => BootstrapTokenStatus::Invalid,
                Some((_, expires_at, false)) if now >= *expires_at => BootstrapTokenStatus::Expired,
                Some((_, _, false)) => BootstrapTokenStatus::Valid,
                _ => BootstrapTokenStatus::Invalid,
            })
        })
    }

    fn claim_owner<'a>(
        &'a self,
        token_hash: &'a str,
        claim: OwnerClaim,
        now: u64,
    ) -> BoxFuture<'a, Result<UserRecord, OwnerClaimError>> {
        Box::pin(async move {
            let mut accounts = self.accounts.lock().await;
            match &accounts.bootstrap {
                Some((hash, expires_at, false)) if hash == token_hash && now < *expires_at => {}
                _ => return Err(OwnerClaimError::InvalidToken),
            }
            let mut users = self.users.write().await;
            if users
                .values()
                .any(|u| u.instance_role == InstanceRole::Owner)
            {
                return Err(OwnerClaimError::OwnerExists);
            }
            let owner = match claim {
                OwnerClaim::NewAccount(mut user) => {
                    let email = user.email.clone().unwrap_or_default().to_lowercase();
                    let mut emails = self.emails.write().await;
                    if emails.contains_key(&email) {
                        return Err(OwnerClaimError::EmailTaken);
                    }
                    user.instance_role = InstanceRole::Owner;
                    emails.insert(email, user.id);
                    users.insert(user.id, user.clone());
                    user
                }
                OwnerClaim::ExistingUser(user_id) => {
                    let user = users
                        .get_mut(&user_id)
                        .ok_or_else(|| OwnerClaimError::Storage("user not found".to_string()))?;
                    user.instance_role = InstanceRole::Owner;
                    user.clone()
                }
            };
            if let Some(bootstrap) = accounts.bootstrap.as_mut() {
                bootstrap.2 = true;
            }
            Ok(owner)
        })
    }

    fn load_or_init_instance_id(
        &self,
        candidate: Uuid,
    ) -> BoxFuture<'_, Result<Uuid, SessionError>> {
        Box::pin(async move {
            Ok(*self
                .accounts
                .lock()
                .await
                .instance_id
                .get_or_insert(candidate))
        })
    }

    fn create_campaign_invite(
        &self,
        invite: CampaignInviteRecord,
    ) -> BoxFuture<'_, Result<CampaignInviteRecord, SessionError>> {
        Box::pin(async move {
            let mut accounts = self.accounts.lock().await;
            for previous in accounts
                .invites
                .iter_mut()
                .filter(|i| i.campaign_id == invite.campaign_id && i.revoked_at.is_none())
            {
                previous.revoked_at = Some(invite.created_at);
            }
            accounts.invites.push(invite.clone());
            Ok(invite)
        })
    }

    fn unrevoked_campaign_invite(
        &self,
        campaign_id: Uuid,
    ) -> BoxFuture<'_, Result<Option<CampaignInviteRecord>, SessionError>> {
        Box::pin(async move {
            Ok(self
                .accounts
                .lock()
                .await
                .invites
                .iter()
                .find(|i| i.campaign_id == campaign_id && i.revoked_at.is_none())
                .cloned())
        })
    }

    fn revoke_campaign_invite(
        &self,
        campaign_id: Uuid,
        now: u64,
    ) -> BoxFuture<'_, Result<Option<CampaignInviteRecord>, SessionError>> {
        Box::pin(async move {
            let mut accounts = self.accounts.lock().await;
            Ok(accounts
                .invites
                .iter_mut()
                .find(|i| i.campaign_id == campaign_id && i.revoked_at.is_none())
                .map(|i| {
                    i.revoked_at = Some(now);
                    i.clone()
                }))
        })
    }

    fn find_campaign_invite<'a>(
        &'a self,
        token_hash: &'a str,
    ) -> BoxFuture<'a, Result<Option<CampaignInviteRecord>, SessionError>> {
        Box::pin(async move {
            Ok(self
                .accounts
                .lock()
                .await
                .invites
                .iter()
                .find(|i| i.token_hash == token_hash)
                .cloned())
        })
    }

    fn redeem_campaign_invite<'a>(
        &'a self,
        token_hash: &'a str,
        redeemer: InviteRedeemer,
        now: u64,
    ) -> BoxFuture<'a, Result<InviteRedemptionOutcome, InviteRedeemError>> {
        Box::pin(async move {
            let mut accounts = self.accounts.lock().await;
            let index = accounts
                .invites
                .iter()
                .position(|i| i.token_hash == token_hash)
                .ok_or(InviteRedeemError::NotFound)?;
            let invite = accounts.invites[index].clone();
            let mut members = self.campaign_members.write().await;
            if let InviteRedeemer::ExistingUser(user_id) = &redeemer {
                if let Some(existing) = members.get(&(invite.campaign_id, *user_id)) {
                    return Ok(InviteRedemptionOutcome {
                        invite,
                        user_id: *user_id,
                        member: existing.clone(),
                        already_member: true,
                    });
                }
                if accounts
                    .redemptions
                    .iter()
                    .any(|(i, u, _)| *i == invite.id && u == user_id)
                {
                    return Err(InviteRedeemError::MemberRemoved);
                }
            }
            let status = invite.status(now);
            if status != InviteStatus::Active {
                return Err(status.into());
            }
            let user_id = match redeemer {
                InviteRedeemer::ExistingUser(user_id) => user_id,
                InviteRedeemer::NewAccount(user) => {
                    let email = user.email.clone().unwrap_or_default().to_lowercase();
                    let mut users = self.users.write().await;
                    let mut emails = self.emails.write().await;
                    if emails.contains_key(&email) {
                        return Err(InviteRedeemError::EmailTaken);
                    }
                    emails.insert(email, user.id);
                    users.insert(user.id, user.clone());
                    user.id
                }
            };
            let member = CampaignMemberRecord {
                campaign_id: invite.campaign_id,
                user_id,
                character_id: None,
                role: INVITE_MEMBER_ROLE.to_string(),
                joined_at: now,
            };
            members.insert((invite.campaign_id, user_id), member.clone());
            accounts.redemptions.push((invite.id, user_id, now));
            accounts.invites[index].use_count += 1;
            Ok(InviteRedemptionOutcome {
                invite: accounts.invites[index].clone(),
                user_id,
                member,
                already_member: false,
            })
        })
    }

    fn list_invite_redemptions(
        &self,
        campaign_id: Uuid,
    ) -> BoxFuture<'_, Result<Vec<InviteRedemptionRecord>, SessionError>> {
        Box::pin(async move {
            let accounts = self.accounts.lock().await;
            let users = self.users.read().await;
            let mut list: Vec<InviteRedemptionRecord> = accounts
                .redemptions
                .iter()
                .filter_map(|(invite_id, user_id, redeemed_at)| {
                    let invite = accounts.invites.iter().find(|i| i.id == *invite_id)?;
                    (invite.campaign_id == campaign_id).then(|| InviteRedemptionRecord {
                        invite_id: *invite_id,
                        campaign_id,
                        user_id: *user_id,
                        display_name: users
                            .get(user_id)
                            .map(|u| u.username.clone())
                            .unwrap_or_default(),
                        redeemed_at: *redeemed_at,
                    })
                })
                .collect();
            list.sort_by(|a, b| b.redeemed_at.cmp(&a.redeemed_at));
            Ok(list)
        })
    }

    fn remove_campaign_member(
        &self,
        campaign_id: Uuid,
        user_id: Uuid,
    ) -> BoxFuture<'_, Result<bool, SessionError>> {
        Box::pin(async move {
            Ok(self
                .campaign_members
                .write()
                .await
                .remove(&(campaign_id, user_id))
                .is_some())
        })
    }
}

/// Lowercases and trims `email`; `None` unless it looks like `local@domain` (<= 255 bytes).
pub fn normalize_email(email: &str) -> Option<String> {
    let email = email.trim().to_lowercase();
    let (local, domain) = email.split_once('@')?;
    (!local.is_empty() && !domain.is_empty() && email.len() <= 255).then_some(email)
}

/// Trims `display_name`; `None` unless it has 2..=100 characters (the `users.display_name` bound).
pub fn normalize_display_name(display_name: &str) -> Option<String> {
    let name = display_name.trim();
    (2..=100)
        .contains(&name.chars().count())
        .then(|| name.to_string())
}

/// Builds a non-guest account record with `instance_role` (password already hashed).
pub fn new_account(
    email: String,
    display_name: String,
    password_hash: String,
    instance_role: InstanceRole,
) -> UserRecord {
    UserRecord {
        id: Uuid::new_v4(),
        username: display_name,
        role: "PLAYER".to_string(),
        is_guest: false,
        created_at: now_epoch_seconds(),
        email: Some(email),
        password_hash: Some(password_hash),
        mfa_enabled: false,
        totp_secret: None,
        pending_totp_secret: None,
        instance_role,
    }
}

/// Creates a session for `user_id` and returns the `Set-Cookie` header carrying it.
pub async fn issue_session_cookie(
    state: &AuthState,
    user_id: Uuid,
) -> Result<HeaderMap, SessionError> {
    let token = generate_session_token();
    state
        .session_store
        .create_session(
            user_id,
            &hash_session_token(&token),
            DEFAULT_SESSION_TTL_SECONDS,
        )
        .await?;
    let mut headers = HeaderMap::new();
    if let Ok(value) =
        HeaderValue::from_str(&state.session_cookie(&token, DEFAULT_SESSION_TTL_SECONDS))
    {
        headers.insert(SET_COOKIE, value);
    }
    Ok(headers)
}
