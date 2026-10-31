//! ============================================================================
//! PURPOSE:
//!   Exposes authentication, session management, Personal Access Tokens (PAT),
//!   and OAuth2 PKCE submodules for TRAME.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - Session tokens and PATs are persisted exclusively as SHA-256 digests.
//!   - PATs use prefix `trame_pat_` followed by 40 random Base62 characters.
//!   - OAuth2 authorization employs SHA-256 PKCE RFC 7636 challenge generation.
//!   - Active guest sessions graduate seamlessly into bound permanent identities.
//! ============================================================================

pub mod magic_link;
pub mod oauth;
pub mod password;
pub mod pat;
pub mod session;
pub mod totp;

pub use magic_link::*;
pub use oauth::*;
pub use password::*;
pub use pat::*;
pub use session::*;
pub use totp::*;
