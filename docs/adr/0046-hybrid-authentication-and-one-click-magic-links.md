# ADR-0046: Hybrid Authentication Architecture and Frictionless Magic Links

## Status
Accepted

## Context
Tabletop Virtual Tabletop (VTT) user acquisition suffers from registration friction. When a Game Master invites players to a session, traditional registration flows (email verification, password selection, profile setup) delay game onboarding. Conversely, Game Masters and administrators require multi-factor authentication (TOTP RFC 6238) and external OAuth2 identity providers (Discord and Google). Automated assistants and Model Context Protocol (MCP) clients also require persistent API access.

## Decision
1. Implement a hybrid identity model supporting four authentication mechanisms:
   - Magic Link URLs (`?invite=<jwt>`): A single-action onboarding token that authenticates the client as an authenticated player attached to a pre-assigned Actor without upfront registration.
   - Email and Password: Stored using Argon2id with memory cost 19,456 KiB, iteration count 2, and parallelism factor 1.
   - OAuth2: Supporting Discord and Google using authorization code flow with PKCE.
   - Personal Access Tokens (`trame_pat_<random_base62>`): Scoped, persistent tokens hashed via SHA-256 in the database.
2. Session management uses secure HTTP cookies (`HttpOnly`, `SameSite=Lax`, `Secure`). The server generates a 256-bit cryptographically secure random session token, computes its SHA-256 digest, and persists the digest in the database `sessions` table.
3. Magic Link authentication establishes a guest player record. When a player subsequently registers a password or connects an OAuth2 provider, the server executes Identity Binding on the existing user record, preserving all actor assignments and notes.
4. TOTP Secrets are encrypted at rest using AES-256-GCM. The encryption key is sourced from the `MASTER_ENCRYPTION_KEY` environment variable (32-byte hex-encoded string).

## Consequences
### Positive
- Players join sessions in one click without registration barriers.
- Player records seamlessly graduate to full credentials via Identity Binding.
- Automated MCP clients gain isolated, scoped programmatic access via PATs.
- High-privilege administrative accounts are protected by TOTP MFA.

### Negative
- The server must manage guest session garbage collection for abandoned invite tokens.
- Handling identity binding requires conflict resolution when an external OAuth email matches an existing password account.