# ADR-0039: Invite-only Registration and Instance-wide `InstanceRole`

## Status
Accepted (2026-11-05). Amends Decision 1 of [ADR-0010](./0010-hybrid-auth-preact-signals-and-postgres-runtime.md): open email + password registration and guest-session onboarding (`GuestSessionUpgrade`) are removed. Records decisions D1, D2, D3, D15 and D16 of [`spec-internet-ready-playable-trame.md`](../specs/spec-internet-ready-playable-trame.md).

## Context
ADR-0010 optimized onboarding for a trusted local network:
- Anyone who reaches the server can create an account through `POST /api/v1/auth/register`.
- Opening a Magic Link invite gives every visitor an authenticated guest `trame_session` cookie bound to the campaign, with optional credential binding later (`GuestSessionUpgrade`).
- Every account can create campaigns. There is no notion of who administers the instance.

The 2026-11-05 security audit flagged this as a blocker for internet exposure. Strangers can register, create campaigns and consume storage (SEC10). Invite links have no TTL cap, no use limit and no revoke, so a leaked link grants unbounded access (SEC7). Guest sessions are not recoverable accounts: a cleared cookie loses the player's characters. Nobody owns the instance, so there is no one entitled to decide who may create campaigns.

## Considered Options
1. **Keep open registration and add CAPTCHA plus rate limiting.** Rejected: it slows bots but still lets any human stranger in, and it adds a third-party dependency.
2. **Accounts created only by an administrator.** Rejected: every new player would need the administrator in the loop, which is too much friction for a group of friends.
3. **Invite-only access with an instance-wide role (Recommended).** The instance has one `Owner` who curates who can create campaigns, and players enter only through a bounded `CampaignInvite`.

## Decision
1. **`InstanceRole`.** Every account carries one `InstanceRole` (`Owner`, `Host`, `Member`), independent of the per-campaign `UserRole`. Exactly one `Owner` exists. New accounts are `Member`. Creating a campaign requires `Host` or `Owner`; the server refuses it for a `Member` and the UI hides the action. Only the `Owner` changes `InstanceRole`s, through an Owner-only admin API that also lists every account.
2. **Owner bootstrap.** When the server boots with no `Owner`, it mints a single-use token valid for 1 hour, stores only its hash, and logs the full setup URL once. Redeeming it creates the `Owner` account. When `TRAME_BOOTSTRAP_OWNER_EMAIL` is set, only that email can claim the instance, so an intercepted URL is useless to anyone else. The token is invalidated after use or expiry; a restart with still no `Owner` mints a fresh one.
3. **Registration closed outside dev.** Public registration is available only with `TRAME_ENV=dev`. Elsewhere, accounts come only from owner bootstrap or `InviteRedemption`.
4. **`CampaignInvite`.** Each campaign has at most one active invite: token hash, creator, `expires_at` (at most 7 days), `max_uses` (default 8), `use_count` and `revoked_at`. Minting a new invite revokes the previous one. Each redemption is stored as its own record (invite, user, timestamp) and listed to the Game Master. The invite URL is built from `TRAME_PUBLIC_ORIGIN`. Create, read-active, revoke and list-redemptions routes are Game Master-only.
5. **`InviteRedemption`.** An unauthenticated redeem creates a `Member` account (display name, email, password) and a `Player` membership in one transaction. An authenticated redeem only adds the membership to the existing account, so no duplicate accounts appear.
6. **Legacy guests.** `GuestSessionUpgrade` is removed and no new guest session is ever issued. A user still holding a legacy guest session keeps the existing bind flow and sees a prompt to bind it to a real account, keeping their characters.
7. **Authorization path.** Every campaign role check goes through `resolve_campaign_role`. The room re-checks membership when it changes and closes the sockets of removed members immediately.
8. **TOTP.** TOTP stays optional for every account. Account settings recommend it, more strongly for the `Owner`.

## Consequences
### Positive
- Strangers cannot create accounts or campaigns on an exposed instance; a leaked invite reaches at most `max_uses` people for at most 7 days and can be revoked at once.
- Every player holds a real, recoverable account, and the Game Master can see exactly who joined.
- Instance administration has a clear owner, and campaign creation is curated without putting the `Owner` in every player's onboarding.

### Negative
- Joining now requires choosing an email and password instead of a single click, which adds about a minute to a player's first visit.
- The setup URL appears in the server log once; operators must read the log promptly (within 1 hour) or restart to mint a new one, and must protect log access until the instance is claimed.
- Two role axes (`InstanceRole` and `UserRole`) must stay distinct in code, UI and docs.
- Existing guest sessions keep working only until they are bound; the bind flow remains as legacy code.
