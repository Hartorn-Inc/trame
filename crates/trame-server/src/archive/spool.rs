//! ============================================================================
//! ARCHIVE UPLOAD SPOOL (spool.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! `ArchiveImporter` needs a seekable reader (the zip central directory sits at
//! the end of the file), but an HTTP request body is a forward-only stream.
//! Buffering the body with `to_bytes` and then copying it into a `Vec` kept up
//! to two 64 MiB copies of every upload in RAM (SEC6). `SpooledArchive` writes
//! the body chunk by chunk to an anonymous temporary file and hands the importer
//! a buffered, seekable file reader instead.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Byte Cap While Streaming`:
//!      - The running byte count is checked after every chunk; the first chunk
//!        that crosses `max_bytes` aborts with `SpoolError::TooLarge`, so an
//!        oversized upload never reaches the disk in full.
//!   2. `No Leftover Files`:
//!      - The temporary file is removed when `SpooledArchive` drops (success,
//!        error, or panic unwinding), and on every spool error path.
//!   3. `Unguessable Path`:
//!      - Files live in `std::env::temp_dir()` under a random UUID name created
//!        with `create_new`, so a pre-existing file is never reused.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `SpooledArchive::from_body(body, max_bytes)`
//!     ├── 1. Create `{temp_dir}/trame-import-{uuid}.zip` (`create_new`).
//!     ├── 2. Append each body frame, aborting past `max_bytes`.
//!     ├── 3. Flush and rewind to offset 0.
//!     └── 4. `reader()` -> `BufReader<File>` for `ArchiveImporter::import_stream`.
//! ============================================================================

use axum::body::Body;
use futures_util::StreamExt;
use std::path::PathBuf;
use tokio::fs::File;
use tokio::io::{AsyncSeekExt, AsyncWriteExt, BufReader};

/// Failure while spooling an upload body.
#[derive(Debug, thiserror::Error)]
pub enum SpoolError {
    /// The body exceeded the configured byte cap.
    #[error("archive upload exceeds {0} bytes")]
    TooLarge(usize),
    /// The client stream broke off mid-upload.
    #[error("archive upload stream failed: {0}")]
    Body(String),
    /// The temporary file could not be written.
    #[error("archive spool io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Upload body written to a temporary file that is deleted on drop.
pub struct SpooledArchive {
    path: PathBuf,
    file: Option<File>,
}

impl SpooledArchive {
    /// Streams `body` into a fresh temporary file, failing once more than `max_bytes`
    /// (bytes) have arrived.
    pub async fn from_body(body: Body, max_bytes: usize) -> Result<Self, SpoolError> {
        let path = std::env::temp_dir().join(format!("trame-import-{}.zip", uuid::Uuid::new_v4()));
        let file = tokio::fs::OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&path)
            .await?;
        let mut spool = Self {
            path,
            file: Some(file),
        };
        spool.fill(body, max_bytes).await?;
        Ok(spool)
    }

    async fn fill(&mut self, body: Body, max_bytes: usize) -> Result<(), SpoolError> {
        let Some(file) = self.file.as_mut() else {
            return Err(SpoolError::Io(std::io::Error::other("spool file closed")));
        };
        let mut stream = body.into_data_stream();
        let mut written = 0usize;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| SpoolError::Body(e.to_string()))?;
            written = written.saturating_add(chunk.len());
            if written > max_bytes {
                return Err(SpoolError::TooLarge(max_bytes));
            }
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        file.rewind().await?;
        Ok(())
    }

    /// Takes the buffered, seekable reader positioned at offset 0. Returns `None` once taken.
    pub fn reader(&mut self) -> Option<BufReader<File>> {
        self.file.take().map(BufReader::new)
    }
}

impl Drop for SpooledArchive {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
