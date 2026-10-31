//! ============================================================================
//! PURPOSE:
//!   Exposes authentication and session management submodules for TRAME
//!   (`magic_link`, `password`, `session`, and `totp`).
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//!   - Session tokens are persisted only as SHA-256 digests (`trame_session`).
//!   - Passwords use OWASP-compliant Argon2id parameters (19 MiB, 2 iterations).
//!   - TOTP secrets are encrypted at rest with AES-256-GCM before persistence.
//!
//! EXECUTION LIFECYCLE:
//!   1. Re-export authentication services, stores, and Axum route handlers.
//! ============================================================================

pub mod magic_link;
pub mod password;
pub mod session;
pub mod totp;

pub use magic_link::*;
pub use password::*;
pub use session::*;
pub use totp::*;
