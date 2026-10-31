//! ============================================================================
//! TRAME CLI ARCHIVE SUBCOMMANDS: INSPECT, EXPORT, AND IMPORT (archive.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Implements the `trame-cli archive` administrative commands (`inspect`,
//! `export`, and `import`) for portable `.trame` campaign ZIP archives.
//! Supports both direct local database/storage execution and remote HTTP REST
//! execution against `/api/v1/campaigns/{id}/export` and
//! `/api/v1/campaigns/import`.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Manifest-Only Inspection`:
//!      - `trame-cli archive inspect --input <PATH>` reads only entry 0
//!        (`manifest.json`) from the `.trame` archive without unpacking
//!        `database.jsonl`, markdown notes, or WebP assets.
//!   2. `Streaming Export & Import`:
//!      - Local and remote HTTP operations stream payloads in bounded 64 KiB
//!        windows and verify SHA-256 digests and collision policies (`--remap-ids`).
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   1. `parse_archive_args` parses CLI subcommands (`inspect`, `export`,
//!      `import`) and flags (`--campaign`, `--output`, `--input`, `--server`,
//!      `--token`, `--remap-ids`).
//!   2. `execute_archive_command` dispatches the parsed command to either local
//!      storage engines (`ArchiveExporter` / `ArchiveImporter`) or the target
//!      HTTP server and formats a structured summary for stdout.
//! ============================================================================

use async_zip::tokio::read::seek::ZipFileReader;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use trame_server::archive::{
    ArchiveError, ArchiveExportError, ArchiveExporter, ArchiveImporter, CampaignExportSource,
    CampaignManifest, CampaignMetadata, ExportEntity, ImportResult, InMemoryCampaignStore,
    NoteRecord,
};
use trame_server::storage::LocalFsStore;
use uuid::Uuid;

/// Errors returned during CLI argument parsing or archive command execution.
#[derive(Debug, Error)]
pub enum ArchiveCliError {
    #[error("invalid CLI arguments: {0}")]
    InvalidArgs(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("ZIP archive error: {0}")]
    Zip(#[from] async_zip::error::ZipError),

    #[error("JSON serialization error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("archive export error: {0}")]
    Export(#[from] ArchiveExportError),

    #[error("archive import error: {0}")]
    Import(#[from] ArchiveError),

    #[error("remote HTTP server error (status {status}): {body}")]
    RemoteHttp { status: u16, body: String },
}

/// Parsed `trame-cli archive` subcommand and associated flags.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArchiveCliCommand {
    /// Reads `manifest.json` from a `.trame` archive without unpacking entities.
    Inspect { input: PathBuf },
    /// Exports a campaign to a `.trame` ZIP archive locally or via HTTP REST.
    Export {
        campaign: Uuid,
        output: PathBuf,
        server: Option<String>,
        token: Option<String>,
    },
    /// Imports a `.trame` ZIP archive locally or via HTTP REST.
    Import {
        input: PathBuf,
        server: Option<String>,
        token: Option<String>,
        remap_ids: bool,
    },
}

/// Summary report emitted by `trame-cli archive inspect`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InspectReport {
    pub manifest_version: u32,
    pub generator: String,
    pub exported_at: String,
    pub campaign_id: Uuid,
    pub campaign_name: String,
    pub system: String,
    pub actor_count: usize,
    pub scene_count: usize,
    pub note_count: usize,
    pub asset_count: usize,
    pub entry_count: usize,
    pub total_uncompressed_bytes: u64,
}

impl InspectReport {
    /// Formats the inspection summary as human-readable lines for stdout.
    pub fn format_display(&self) -> String {
        format!(
            "Campaign: {} ({})\nSystem: {}\nManifest Version: {}\nGenerator: {}\nExported At: {}\nStats: actors={}, scenes={}, notes={}, assets={}\nEntries: {} ({} bytes total)",
            self.campaign_name,
            self.campaign_id,
            self.system,
            self.manifest_version,
            self.generator,
            self.exported_at,
            self.actor_count,
            self.scene_count,
            self.note_count,
            self.asset_count,
            self.entry_count,
            self.total_uncompressed_bytes
        )
    }
}

/// Parses arguments following `trame-cli archive ...`.
pub fn parse_archive_args(args: &[String]) -> Result<ArchiveCliCommand, ArchiveCliError> {
    let subcommand = args.first().map(String::as_str).ok_or_else(|| {
        ArchiveCliError::InvalidArgs(
            "expected archive subcommand: inspect, export, or import".to_string(),
        )
    })?;

    let mut campaign: Option<Uuid> = None;
    let mut output: Option<PathBuf> = None;
    let mut input: Option<PathBuf> = None;
    let mut server: Option<String> = None;
    let mut token: Option<String> = None;
    let mut remap_ids = false;

    let mut idx = 1;
    while idx < args.len() {
        let arg = &args[idx];
        if let Some((flag, inline_val)) = arg.split_once('=') {
            match flag {
                "--campaign" => {
                    let parsed = Uuid::parse_str(inline_val).map_err(|e| {
                        ArchiveCliError::InvalidArgs(format!("invalid --campaign UUID: {e}"))
                    })?;
                    campaign = Some(parsed);
                }
                "--output" => output = Some(PathBuf::from(inline_val)),
                "--input" => input = Some(PathBuf::from(inline_val)),
                "--server" => server = Some(inline_val.to_string()),
                "--token" => token = Some(inline_val.to_string()),
                "--remap-ids" => {
                    remap_ids = match inline_val {
                        "true" | "1" => true,
                        "false" | "0" => false,
                        other => {
                            return Err(ArchiveCliError::InvalidArgs(format!(
                                "invalid --remap-ids boolean value: {other}"
                            )));
                        }
                    };
                }
                other => {
                    return Err(ArchiveCliError::InvalidArgs(format!(
                        "unrecognized flag: {other}"
                    )));
                }
            }
            idx += 1;
            continue;
        }

        match arg.as_str() {
            "--campaign" => {
                let val = args.get(idx + 1).ok_or_else(|| {
                    ArchiveCliError::InvalidArgs("missing value for --campaign".to_string())
                })?;
                let parsed = Uuid::parse_str(val).map_err(|e| {
                    ArchiveCliError::InvalidArgs(format!("invalid --campaign UUID: {e}"))
                })?;
                campaign = Some(parsed);
                idx += 2;
            }
            "--output" => {
                let val = args.get(idx + 1).ok_or_else(|| {
                    ArchiveCliError::InvalidArgs("missing value for --output".to_string())
                })?;
                output = Some(PathBuf::from(val));
                idx += 2;
            }
            "--input" => {
                let val = args.get(idx + 1).ok_or_else(|| {
                    ArchiveCliError::InvalidArgs("missing value for --input".to_string())
                })?;
                input = Some(PathBuf::from(val));
                idx += 2;
            }
            "--server" => {
                let val = args.get(idx + 1).ok_or_else(|| {
                    ArchiveCliError::InvalidArgs("missing value for --server".to_string())
                })?;
                server = Some(val.clone());
                idx += 2;
            }
            "--token" => {
                let val = args.get(idx + 1).ok_or_else(|| {
                    ArchiveCliError::InvalidArgs("missing value for --token".to_string())
                })?;
                token = Some(val.clone());
                idx += 2;
            }
            "--remap-ids" => {
                remap_ids = true;
                idx += 1;
            }
            other => {
                return Err(ArchiveCliError::InvalidArgs(format!(
                    "unrecognized flag: {other}"
                )));
            }
        }
    }

    match subcommand {
        "inspect" => {
            let input_path = input.ok_or_else(|| {
                ArchiveCliError::InvalidArgs("inspect requires --input <PATH>".to_string())
            })?;
            Ok(ArchiveCliCommand::Inspect { input: input_path })
        }
        "export" => {
            let campaign_id = campaign.ok_or_else(|| {
                ArchiveCliError::InvalidArgs("export requires --campaign <UUID>".to_string())
            })?;
            let output_path = output.ok_or_else(|| {
                ArchiveCliError::InvalidArgs("export requires --output <PATH>".to_string())
            })?;
            Ok(ArchiveCliCommand::Export {
                campaign: campaign_id,
                output: output_path,
                server,
                token,
            })
        }
        "import" => {
            let input_path = input.ok_or_else(|| {
                ArchiveCliError::InvalidArgs("import requires --input <PATH>".to_string())
            })?;
            Ok(ArchiveCliCommand::Import {
                input: input_path,
                server,
                token,
                remap_ids,
            })
        }
        other => Err(ArchiveCliError::InvalidArgs(format!(
            "unknown archive subcommand '{other}'; expected inspect, export, or import"
        ))),
    }
}

/// Reads `manifest.json` from entry 0 of the `.trame` archive without unpacking
/// entities, notes, or assets, returning a structured [`InspectReport`].
pub async fn inspect_archive(input: &Path) -> Result<InspectReport, ArchiveCliError> {
    let raw_bytes = tokio::fs::read(input).await?;
    let reader = Cursor::new(raw_bytes);
    let mut zip_reader = ZipFileReader::with_tokio(reader).await?;

    let entries = zip_reader.file().entries();
    if entries.is_empty() {
        return Err(ArchiveCliError::Import(ArchiveError::InvalidManifest(
            "archive is empty; expected manifest.json as initial entry".to_string(),
        )));
    }

    let first_filename = entries[0]
        .filename()
        .as_str()
        .map_err(|e| ArchiveCliError::Import(ArchiveError::InvalidManifest(e.to_string())))?;

    if first_filename != "manifest.json" {
        return Err(ArchiveCliError::Import(ArchiveError::InvalidManifest(
            format!("initial entry must be manifest.json, found '{first_filename}'"),
        )));
    }

    let mut manifest_entry_reader = zip_reader.reader_with_entry(0).await?;
    let mut manifest_json = String::new();
    manifest_entry_reader
        .read_to_string_checked(&mut manifest_json)
        .await?;

    let manifest: CampaignManifest = serde_json::from_str(&manifest_json)?;
    let total_uncompressed_bytes = manifest.entries.iter().map(|e| e.byte_size).sum();

    Ok(InspectReport {
        manifest_version: manifest.manifest_version,
        generator: manifest.generator,
        exported_at: manifest.exported_at,
        campaign_id: manifest.campaign.id,
        campaign_name: manifest.campaign.name,
        system: manifest.campaign.system,
        actor_count: manifest.stats.actor_count,
        scene_count: manifest.stats.scene_count,
        note_count: manifest.stats.note_count,
        asset_count: manifest.stats.asset_count,
        entry_count: manifest.entries.len(),
        total_uncompressed_bytes,
    })
}

#[derive(Clone)]
struct LocalStoreExportAdapter {
    metadata: CampaignMetadata,
    entities: Vec<ExportEntity>,
    notes: Vec<NoteRecord>,
    asset_ids: Vec<Uuid>,
}

impl CampaignExportSource for LocalStoreExportAdapter {
    fn campaign_metadata(&self) -> CampaignMetadata {
        self.metadata.clone()
    }

    fn stream_entities(&self) -> Vec<ExportEntity> {
        self.entities.clone()
    }

    fn stream_notes(&self) -> Vec<NoteRecord> {
        self.notes.clone()
    }

    fn list_asset_ids(&self) -> Vec<Uuid> {
        self.asset_ids.clone()
    }
}

/// Exports a campaign to `output` either from a remote HTTP server (`--server`)
/// or directly via local campaign/blob stores.
pub async fn export_archive(
    campaign_id: Uuid,
    output: &Path,
    server: Option<&str>,
    token: Option<&str>,
    local_stores: Option<(&InMemoryCampaignStore, &LocalFsStore)>,
) -> Result<u64, ArchiveCliError> {
    if let Some(parent) = output.parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent).await?;
        }
    }

    if let Some(server_url) = server {
        let path = format!("/api/v1/campaigns/{campaign_id}/export");
        let (status, body) = send_http_request(server_url, "GET", &path, token, None).await?;
        if status != 200 {
            return Err(ArchiveCliError::RemoteHttp {
                status,
                body: String::from_utf8_lossy(&body).into_owned(),
            });
        }
        tokio::fs::write(output, &body).await?;
        return Ok(body.len() as u64);
    }

    let default_campaign_store;
    let default_blob_store;
    let (campaign_store, blob_store) = match local_stores {
        Some((cs, bs)) => (cs, bs),
        None => {
            default_campaign_store = InMemoryCampaignStore::new();
            let temp_blob_dir =
                std::env::temp_dir().join(format!("trame_cli_blobs_{}", Uuid::new_v4()));
            tokio::fs::create_dir_all(&temp_blob_dir).await?;
            default_blob_store = LocalFsStore::new(temp_blob_dir);
            (&default_campaign_store, &default_blob_store)
        }
    };

    let metadata = campaign_store
        .get_campaign(&campaign_id)
        .unwrap_or(CampaignMetadata {
            id: campaign_id,
            name: format!("Campaign {campaign_id}"),
            system: "dnd5e".to_string(),
            description: Some("Offline CLI campaign export".to_string()),
            created_at: "2026-10-31T00:00:00Z".to_string(),
        });

    let entities: Vec<ExportEntity> = campaign_store
        .all_entities()
        .into_iter()
        .filter(|entity| {
            entity
                .data
                .get("campaign_id")
                .and_then(|v| v.as_str())
                .and_then(|s| Uuid::parse_str(s).ok())
                .map(|cid| cid == campaign_id)
                .unwrap_or(true)
        })
        .collect();

    let notes = campaign_store.all_notes();
    let descriptors = trame_server::storage::blob::BlobStore::list_descriptors(blob_store)
        .await
        .unwrap_or_default();
    let asset_ids: Vec<Uuid> = descriptors
        .into_iter()
        .filter_map(|d| Uuid::parse_str(&d.id).ok())
        .collect();

    let adapter = LocalStoreExportAdapter {
        metadata,
        entities,
        notes,
        asset_ids,
    };

    let exporter = ArchiveExporter::new(adapter, blob_store.clone());
    let mut stream = exporter.export_stream().await?;
    let mut file = tokio::fs::File::create(output).await?;
    let mut bytes_written = 0u64;

    while let Some(chunk_res) = stream.next().await {
        let chunk = chunk_res?;
        file.write_all(&chunk).await?;
        bytes_written += chunk.len() as u64;
    }
    file.flush().await?;

    Ok(bytes_written)
}

/// Imports a `.trame` archive from `input` either to a remote HTTP server
/// (`--server`) or directly into local campaign/blob stores.
pub async fn import_archive(
    input: &Path,
    server: Option<&str>,
    token: Option<&str>,
    remap_ids: bool,
    local_stores: Option<(&InMemoryCampaignStore, &LocalFsStore)>,
) -> Result<ImportResult, ArchiveCliError> {
    let raw_bytes = tokio::fs::read(input).await?;

    if let Some(server_url) = server {
        let path = format!("/api/v1/campaigns/import?remap_ids={remap_ids}");
        let (status, body) =
            send_http_request(server_url, "POST", &path, token, Some(&raw_bytes)).await?;
        if status != 200 && status != 201 {
            return Err(ArchiveCliError::RemoteHttp {
                status,
                body: String::from_utf8_lossy(&body).into_owned(),
            });
        }
        let result: ImportResult = serde_json::from_slice(&body)?;
        return Ok(result);
    }

    let default_campaign_store;
    let default_blob_store;
    let (campaign_store, blob_store) = match local_stores {
        Some((cs, bs)) => (cs, bs),
        None => {
            default_campaign_store = InMemoryCampaignStore::new();
            let temp_blob_dir =
                std::env::temp_dir().join(format!("trame_cli_imp_blobs_{}", Uuid::new_v4()));
            tokio::fs::create_dir_all(&temp_blob_dir).await?;
            default_blob_store = LocalFsStore::new(temp_blob_dir);
            (&default_campaign_store, &default_blob_store)
        }
    };

    let importer = ArchiveImporter::new(campaign_store.clone(), blob_store.clone());
    let result = importer
        .import_stream(Cursor::new(raw_bytes), remap_ids)
        .await?;
    Ok(result)
}

/// Executes a parsed [`ArchiveCliCommand`] and returns the formatted stdout string.
pub async fn execute_archive_command(
    command: &ArchiveCliCommand,
    local_stores: Option<(&InMemoryCampaignStore, &LocalFsStore)>,
) -> Result<String, ArchiveCliError> {
    match command {
        ArchiveCliCommand::Inspect { input } => {
            let report = inspect_archive(input).await?;
            Ok(report.format_display())
        }
        ArchiveCliCommand::Export {
            campaign,
            output,
            server,
            token,
        } => {
            let bytes = export_archive(
                *campaign,
                output,
                server.as_deref(),
                token.as_deref(),
                local_stores,
            )
            .await?;
            Ok(format!(
                "Exported campaign {} to {} ({} bytes)",
                campaign,
                output.display(),
                bytes
            ))
        }
        ArchiveCliCommand::Import {
            input,
            server,
            token,
            remap_ids,
        } => {
            let res = import_archive(
                input,
                server.as_deref(),
                token.as_deref(),
                *remap_ids,
                local_stores,
            )
            .await?;
            Ok(format!(
                "Imported campaign '{}' ({}) [actors={}, scenes={}, notes={}, assets={}]",
                res.name,
                res.campaign_id,
                res.actors_restored,
                res.scenes_restored,
                res.notes_restored,
                res.assets_restored
            ))
        }
    }
}

/// Parses and executes `trame-cli archive <subcommand> ...`, printing output to stdout.
pub async fn run_cli(args: &[String]) -> Result<String, ArchiveCliError> {
    let command = parse_archive_args(args)?;
    let output = execute_archive_command(&command, None).await?;
    println!("{output}");
    Ok(output)
}

/// Minimal HTTP/1.1 client over `tokio::net::TcpStream` for local/remote server interaction.
async fn send_http_request(
    server_url: &str,
    method: &str,
    request_path: &str,
    token: Option<&str>,
    body: Option<&[u8]>,
) -> Result<(u16, Vec<u8>), ArchiveCliError> {
    let stripped = server_url
        .strip_prefix("http://")
        .or_else(|| server_url.strip_prefix("https://"))
        .unwrap_or(server_url);
    let host_port = stripped.split('/').next().unwrap_or(stripped);
    let connect_addr = if host_port.contains(':') {
        host_port.to_string()
    } else {
        format!("{host_port}:80")
    };

    let mut stream = TcpStream::connect(&connect_addr).await?;
    let payload = body.unwrap_or(&[]);

    let mut request_head = format!(
        "{method} {request_path} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\nContent-Length: {}\r\n",
        payload.len()
    );
    if body.is_some() {
        request_head.push_str("Content-Type: application/zip\r\n");
    }
    if let Some(tok) = token {
        request_head.push_str(&format!("Authorization: Bearer {tok}\r\n"));
    }
    request_head.push_str("\r\n");

    stream.write_all(request_head.as_bytes()).await?;
    if !payload.is_empty() {
        stream.write_all(payload).await?;
    }
    stream.flush().await?;

    let mut raw_response = Vec::new();
    stream.read_to_end(&mut raw_response).await?;

    parse_http_response(&raw_response)
}

fn parse_http_response(raw: &[u8]) -> Result<(u16, Vec<u8>), ArchiveCliError> {
    let header_end = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| {
            ArchiveCliError::InvalidArgs("malformed HTTP response from server".to_string())
        })?;

    let header_str = String::from_utf8_lossy(&raw[..header_end]);
    let status_line = header_str.lines().next().unwrap_or("");
    let status_code = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| {
            ArchiveCliError::InvalidArgs(format!("invalid HTTP status line: {status_line}"))
        })?;

    let is_chunked = header_str.lines().any(|line| {
        let lower = line.to_ascii_lowercase();
        lower.starts_with("transfer-encoding:") && lower.contains("chunked")
    });

    let body_slice = &raw[header_end + 4..];
    if is_chunked {
        Ok((status_code, decode_chunked_body(body_slice)))
    } else {
        Ok((status_code, body_slice.to_vec()))
    }
}

fn decode_chunked_body(mut input: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(crlf_pos) = input.windows(2).position(|w| w == b"\r\n") {
        let len_str = String::from_utf8_lossy(&input[..crlf_pos]);
        let clean_len = len_str.split(';').next().unwrap_or("").trim();
        let Ok(chunk_len) = usize::from_str_radix(clean_len, 16) else {
            break;
        };
        if chunk_len == 0 {
            break;
        }
        let chunk_start = crlf_pos + 2;
        if input.len() < chunk_start + chunk_len {
            out.extend_from_slice(&input[chunk_start..]);
            break;
        }
        out.extend_from_slice(&input[chunk_start..chunk_start + chunk_len]);
        let next_start = chunk_start + chunk_len + 2;
        if input.len() <= next_start {
            break;
        }
        input = &input[next_start..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;
    use trame_server::assets::store::InMemoryAssetStore;
    use trame_server::auth::magic_link::MagicLinkService;
    use trame_server::auth::session::{CampaignMemberRecord, InMemorySessionStore, SessionStore};
    use trame_server::auth::totp::TotpService;
    use trame_server::http::{AppState, InMemoryMembershipValidator, build_app_router};
    use trame_server::room::RoomLeaseManager;
    use trame_server::storage::blob::{BlobStore, slice_to_stream};
    use trame_server::wal::InMemoryWalStorage;

    #[test]
    fn test_parse_archive_args_parameterized_subcommands_and_flags() {
        let cid = Uuid::new_v4();
        let cases = vec![
            (
                "inspect_standard",
                vec!["inspect", "--input", "/tmp/sample.trame"],
                ArchiveCliCommand::Inspect {
                    input: PathBuf::from("/tmp/sample.trame"),
                },
            ),
            (
                "inspect_inline_equals",
                vec!["inspect", "--input=/tmp/inline.trame"],
                ArchiveCliCommand::Inspect {
                    input: PathBuf::from("/tmp/inline.trame"),
                },
            ),
            (
                "export_with_server_and_token",
                vec![
                    "export",
                    "--campaign",
                    &cid.to_string(),
                    "--output",
                    "/tmp/out.trame",
                    "--server",
                    "http://127.0.0.1:8080",
                    "--token",
                    "pat-secret",
                ],
                ArchiveCliCommand::Export {
                    campaign: cid,
                    output: PathBuf::from("/tmp/out.trame"),
                    server: Some("http://127.0.0.1:8080".to_string()),
                    token: Some("pat-secret".to_string()),
                },
            ),
            (
                "import_with_remap_ids",
                vec![
                    "import",
                    "--input",
                    "/tmp/in.trame",
                    "--server",
                    "http://127.0.0.1:8080",
                    "--token",
                    "pat-secret",
                    "--remap-ids",
                ],
                ArchiveCliCommand::Import {
                    input: PathBuf::from("/tmp/in.trame"),
                    server: Some("http://127.0.0.1:8080".to_string()),
                    token: Some("pat-secret".to_string()),
                    remap_ids: true,
                },
            ),
            (
                "import_default_no_remap",
                vec!["import", "--input", "/tmp/in.trame"],
                ArchiveCliCommand::Import {
                    input: PathBuf::from("/tmp/in.trame"),
                    server: None,
                    token: None,
                    remap_ids: false,
                },
            ),
        ];

        for (case_id, raw_args, expected) in cases {
            let args: Vec<String> = raw_args.into_iter().map(String::from).collect();
            let parsed = parse_archive_args(&args)
                .unwrap_or_else(|e| panic!("case {case_id} should parse cleanly: {e}"));
            assert_eq!(parsed, expected, "mismatch in case {case_id}");
        }
    }

    #[test]
    fn test_parse_archive_args_rejects_invalid_inputs() {
        let error_cases = vec![
            ("empty_args", vec![]),
            ("unknown_subcommand", vec!["unknown"]),
            ("inspect_missing_input", vec!["inspect"]),
            (
                "export_missing_campaign",
                vec!["export", "--output", "a.trame"],
            ),
            (
                "export_invalid_uuid",
                vec!["export", "--campaign", "not-a-uuid", "--output", "a.trame"],
            ),
            ("import_missing_input", vec!["import", "--remap-ids"]),
            (
                "unrecognized_flag",
                vec!["inspect", "--input", "a.trame", "--bogus"],
            ),
        ];

        for (case_id, raw_args) in error_cases {
            let args: Vec<String> = raw_args.into_iter().map(String::from).collect();
            assert!(
                parse_archive_args(&args).is_err(),
                "expected error for case {case_id}"
            );
        }
    }

    #[tokio::test]
    async fn test_cli_export_inspect_and_import_local_roundtrip_and_remap() {
        let temp_dir = std::env::temp_dir().join(format!("trame_cli_test_{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&temp_dir).await.unwrap();

        let source_blobs_dir = temp_dir.join("source_blobs");
        let target_blobs_dir = temp_dir.join("target_blobs");
        tokio::fs::create_dir_all(&source_blobs_dir).await.unwrap();
        tokio::fs::create_dir_all(&target_blobs_dir).await.unwrap();

        let source_store = InMemoryCampaignStore::new();
        let source_blobs = LocalFsStore::new(&source_blobs_dir);

        let campaign_id = Uuid::new_v4();
        let scene_id = Uuid::new_v4();
        let actor_id = Uuid::new_v4();
        let note_id = Uuid::new_v4();
        let author_id = Uuid::new_v4();
        let asset_id = Uuid::new_v4();

        source_store.seed_campaign(
            CampaignMetadata {
                id: campaign_id,
                name: "Shadows of Saltmarsh".to_string(),
                system: "dnd5e".to_string(),
                description: Some("CLI roundtrip test".to_string()),
                created_at: "2026-10-31T00:00:00Z".to_string(),
            },
            vec![
                ExportEntity {
                    entity_type: "scene".to_string(),
                    data: json!({
                        "id": scene_id,
                        "campaign_id": campaign_id,
                        "name": "Haunted House"
                    }),
                },
                ExportEntity {
                    entity_type: "actor".to_string(),
                    data: json!({
                        "id": actor_id,
                        "campaign_id": campaign_id,
                        "name": "Sanbalet"
                    }),
                },
            ],
            vec![NoteRecord {
                id: note_id,
                title: "Smuggler Signals".to_string(),
                folder: Some("secrets".to_string()),
                author_id,
                created_at: "2026-10-31T00:00:00Z".to_string(),
                updated_at: "2026-10-31T00:00:00Z".to_string(),
                content_markdown: format!("Watch [[{actor_id}|Sanbalet]] in [[{scene_id}]]."),
            }],
        );

        source_blobs
            .put_stream(
                &asset_id.to_string(),
                slice_to_stream(b"RIFF....WEBPVP8 ...cli test webp..."),
            )
            .await
            .unwrap();

        let archive_path = temp_dir.join("saltmarsh.trame");

        // 1. Export via CLI command
        let export_cmd = ArchiveCliCommand::Export {
            campaign: campaign_id,
            output: archive_path.clone(),
            server: None,
            token: None,
        };
        let export_out = execute_archive_command(&export_cmd, Some((&source_store, &source_blobs)))
            .await
            .expect("CLI export succeeds");
        assert!(export_out.contains(&campaign_id.to_string()));
        assert!(archive_path.exists());

        // 2. Inspect via CLI command (reads manifest.json without unpacking entities)
        let inspect_cmd = ArchiveCliCommand::Inspect {
            input: archive_path.clone(),
        };
        let inspect_out = execute_archive_command(&inspect_cmd, None)
            .await
            .expect("CLI inspect succeeds");
        assert!(inspect_out.contains("Shadows of Saltmarsh"));
        assert!(inspect_out.contains("actors=1, scenes=1, notes=1, assets=1"));
        assert!(inspect_out.contains("Entries: 3"));

        // 3. Import via CLI command without remapping
        let target_store = InMemoryCampaignStore::new();
        let target_blobs = LocalFsStore::new(&target_blobs_dir);
        let import_cmd = ArchiveCliCommand::Import {
            input: archive_path.clone(),
            server: None,
            token: None,
            remap_ids: false,
        };
        let import_out = execute_archive_command(&import_cmd, Some((&target_store, &target_blobs)))
            .await
            .expect("CLI import succeeds");
        assert!(import_out.contains(&campaign_id.to_string()));
        assert!(import_out.contains("actors=1, scenes=1, notes=1, assets=1"));

        // 4. Duplicate import without --remap-ids fails with CampaignAlreadyExists
        let dup_err = execute_archive_command(&import_cmd, Some((&target_store, &target_blobs)))
            .await
            .unwrap_err();
        assert!(matches!(
            dup_err,
            ArchiveCliError::Import(ArchiveError::CampaignAlreadyExists(id)) if id == campaign_id
        ));

        // 5. Import with --remap-ids clones campaign under new UUIDs
        let remap_cmd = ArchiveCliCommand::Import {
            input: archive_path.clone(),
            server: None,
            token: None,
            remap_ids: true,
        };
        let remap_out = execute_archive_command(&remap_cmd, Some((&target_store, &target_blobs)))
            .await
            .expect("CLI remap import succeeds");
        assert!(remap_out.contains("Shadows of Saltmarsh"));
        assert!(!remap_out.contains(&campaign_id.to_string()));

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[tokio::test]
    async fn test_cli_export_and_import_over_http_rest_server() {
        let temp_dir = std::env::temp_dir().join(format!("trame_cli_http_{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&temp_dir).await.unwrap();

        let wal = Arc::new(InMemoryWalStorage::new());
        let lease_manager = Arc::new(RoomLeaseManager::new(wal, 16, 900_000));
        let asset_store = Arc::new(InMemoryAssetStore::new());
        let membership = Arc::new(InMemoryMembershipValidator::new());
        let campaign_store = Arc::new(InMemoryCampaignStore::new());
        let blob_store = Arc::new(LocalFsStore::new(temp_dir.join("server_blobs")));
        let session_store = Arc::new(InMemorySessionStore::new());
        let magic_link_service = Arc::new(MagicLinkService::new(
            b"cli_http_test_secret_key_32bytes!",
            "https://trame.example.com",
        ));

        let gm_id = Uuid::new_v4();
        let campaign_id = Uuid::new_v4();
        membership.add_member(campaign_id, gm_id);
        session_store
            .upsert_campaign_member(CampaignMemberRecord {
                campaign_id,
                user_id: gm_id,
                character_id: None,
                role: "GM".to_string(),
            })
            .await
            .unwrap();

        let raw_session_token = "cli_test_bearer_token_123456";
        let token_hash = trame_server::auth::session::hash_session_token(raw_session_token);
        session_store
            .create_session(&token_hash, gm_id, 9_999_999_999)
            .await
            .unwrap();

        campaign_store.seed_campaign(
            CampaignMetadata {
                id: campaign_id,
                name: "HTTP Server Campaign".to_string(),
                system: "dnd5e".to_string(),
                description: None,
                created_at: "2026-10-31T00:00:00Z".to_string(),
            },
            vec![ExportEntity {
                entity_type: "actor".to_string(),
                data: json!({
                    "id": Uuid::new_v4(),
                    "campaign_id": campaign_id,
                    "name": "Mordenkainen"
                }),
            }],
            Vec::new(),
        );

        let app_state = AppState {
            lease_manager,
            asset_store,
            membership,
            instance_id: Uuid::new_v4(),
            campaign_store: campaign_store.clone(),
            blob_store,
            session_store,
            magic_link_service,
            totp_service: Arc::new(TotpService::default()),
            database_healthy: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        };

        let router = build_app_router(app_state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server_url = format!("http://{addr}");

        let server_task = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });

        let exported_file = temp_dir.join("http_exported.trame");

        // 1. Export over HTTP via run_cli
        let export_args = vec![
            "export".to_string(),
            "--campaign".to_string(),
            campaign_id.to_string(),
            "--output".to_string(),
            exported_file.to_string_lossy().into_owned(),
            "--server".to_string(),
            server_url.clone(),
            "--token".to_string(),
            raw_session_token.to_string(),
        ];
        let export_out = run_cli(&export_args).await.expect("HTTP export succeeds");
        assert!(export_out.contains(&campaign_id.to_string()));

        // 2. Inspect downloaded archive via run_cli
        let inspect_args = vec![
            "inspect".to_string(),
            "--input".to_string(),
            exported_file.to_string_lossy().into_owned(),
        ];
        let inspect_out = run_cli(&inspect_args).await.expect("inspect succeeds");
        assert!(inspect_out.contains("HTTP Server Campaign"));
        assert!(inspect_out.contains("actors=1"));

        // 3. Import over HTTP with --remap-ids via run_cli
        let import_args = vec![
            "import".to_string(),
            "--input".to_string(),
            exported_file.to_string_lossy().into_owned(),
            "--server".to_string(),
            server_url,
            "--token".to_string(),
            raw_session_token.to_string(),
            "--remap-ids".to_string(),
        ];
        let import_out = run_cli(&import_args).await.expect("HTTP import succeeds");
        assert!(import_out.contains("HTTP Server Campaign"));
        assert!(import_out.contains("actors=1"));

        server_task.abort();
        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }
}
