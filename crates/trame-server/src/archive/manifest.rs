//! Manifest types and cryptographic entry descriptors for .trame campaign archives.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Current specification version for manifest.json.
pub const MANIFEST_VERSION: u32 = 1;

/// Default generator identifier for exports created by trame-server.
pub const DEFAULT_GENERATOR: &str = "trame-server 0.1.0";

/// Metadata identifying the exported campaign.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CampaignMetadata {
    pub id: Uuid,
    pub name: String,
    pub system: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub created_at: String,
}

/// Aggregated counts and uncompressed byte totals for the archive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ManifestStats {
    pub actor_count: usize,
    pub scene_count: usize,
    pub note_count: usize,
    pub asset_count: usize,
    pub total_uncompressed_bytes: u64,
}

/// Descriptor of a single file in the .trame archive recording byte size and SHA-256 digest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchiveEntryDescriptor {
    pub path: String,
    pub byte_size: u64,
    pub sha256: String,
}

/// Complete schema for `manifest.json` written as the first entry in a .trame archive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CampaignManifest {
    pub manifest_version: u32,
    pub generator: String,
    pub exported_at: String,
    pub campaign: CampaignMetadata,
    pub stats: ManifestStats,
    pub entries: Vec<ArchiveEntryDescriptor>,
}

impl CampaignManifest {
    /// Creates a new manifest with current version and generator stamp.
    pub fn new(
        campaign: CampaignMetadata,
        exported_at: String,
        stats: ManifestStats,
        entries: Vec<ArchiveEntryDescriptor>,
    ) -> Self {
        Self {
            manifest_version: MANIFEST_VERSION,
            generator: DEFAULT_GENERATOR.to_string(),
            exported_at,
            campaign,
            stats,
            entries,
        }
    }
}
