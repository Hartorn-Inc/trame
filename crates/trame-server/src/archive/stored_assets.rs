//! ============================================================================
//! CONTENT-ADDRESSED ASSET KEYS IN ARCHIVES (stored_assets.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Campaign data references uploaded images by their `AssetStore` key,
//! `instances/{instance}/campaigns/{campaign}/assets/{stem}.webp` (`stem` is a
//! 64-hex SHA-256, optionally suffixed `_thumb`): scene `background_image_url`,
//! staged token avatars, actor `portraitAssetKey`, image links in notes. The key
//! embeds the owning campaign, so after an import every reference would point at
//! the source campaign. This module finds those keys and rewrites them.
//!
//! WHY EMBED THE BYTES (not copy on the server):
//! ---------------------------------------------
//! A `.trame` archive is portable across instances, so the source blobs may not
//! exist where it is imported. Export therefore embeds every referenced blob as a
//! `stored-assets/{stem}.webp` entry (checksummed in the manifest like any other
//! entry), and import re-stores it under the new campaign's key.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Campaign Scoping`:
//!      - Only keys whose campaign segment equals the exported campaign are collected,
//!        so an export never pulls another campaign's blobs.
//!   2. `Strict Stem Grammar`:
//!      - Stems must be 64 lowercase hex digits plus an optional `_thumb`; entry names
//!        outside that grammar are rejected, so archive paths cannot inject key segments.
//!   3. `Buffered Size Cap`:
//!      - `stored-assets/` entries are buffered (the `AssetStore` API takes whole
//!        `Bytes`), so they share the 32 MiB `MAX_TEXT_ENTRY_BYTES` cap, not the 64 MiB
//!        streamed `assets/` cap.
//!   4. `WebP Magic Bytes`:
//!      - Imported blobs must start with `RIFF....WEBP`; anything else fails the import.
//! ============================================================================

use uuid::Uuid;

/// Archive directory holding embedded content-addressed blobs (`stored-assets/{stem}.webp`).
pub const STORED_ASSET_PREFIX: &str = "stored-assets/";

/// `true` for `{64 lowercase hex}` or `{64 lowercase hex}_thumb`.
pub fn is_valid_stem(stem: &str) -> bool {
    let hash = stem.strip_suffix("_thumb").unwrap_or(stem);
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `true` when `bytes` carry the RIFF/WebP container signature.
pub fn is_webp(bytes: &[u8]) -> bool {
    bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP"
}

/// `AssetStore` key of `stem` for `campaign_id` on `instance_id`.
pub fn asset_key(instance_id: Uuid, campaign_id: Uuid, stem: &str) -> String {
    format!("instances/{instance_id}/campaigns/{campaign_id}/assets/{stem}.webp")
}

/// One asset key found in a text: byte span and stem.
struct KeyMatch {
    start: usize,
    end: usize,
    stem: String,
}

/// Finds every `instances/{uuid}/campaigns/{campaign_id}/assets/{stem}.webp` in `text`.
fn find_keys(text: &str, campaign_id: Uuid) -> Vec<KeyMatch> {
    let needle = format!("/campaigns/{campaign_id}/assets/");
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(pos) = text[from..].find(&needle) {
        let at = from + pos;
        from = at + needle.len();
        // `instances/` (10 bytes) + a 36-byte UUID must precede the needle.
        let Some(start) = at.checked_sub(46) else {
            continue;
        };
        let Some(prefix) = text.get(start..at) else {
            continue;
        };
        if !prefix.starts_with("instances/") || Uuid::parse_str(&prefix[10..]).is_err() {
            continue;
        }
        let rest = &text[from..];
        let Some(dot) = rest.find(".webp") else {
            continue;
        };
        let stem = &rest[..dot];
        if !is_valid_stem(stem) {
            continue;
        }
        let end = from + dot + ".webp".len();
        out.push(KeyMatch {
            start,
            end,
            stem: stem.to_string(),
        });
        from = end;
    }
    out
}

/// `(key, stem)` of every asset of `campaign_id` referenced in `text`.
pub fn referenced_keys(text: &str, campaign_id: Uuid) -> Vec<(String, String)> {
    find_keys(text, campaign_id)
        .into_iter()
        .map(|m| (text[m.start..m.end].to_string(), m.stem))
        .collect()
}

/// `referenced_keys` over every string inside a JSON value.
pub fn referenced_keys_in_json(
    value: &serde_json::Value,
    campaign_id: Uuid,
    out: &mut Vec<(String, String)>,
) {
    match value {
        serde_json::Value::String(s) => out.extend(referenced_keys(s, campaign_id)),
        serde_json::Value::Array(items) => items
            .iter()
            .for_each(|v| referenced_keys_in_json(v, campaign_id, out)),
        serde_json::Value::Object(map) => map
            .values()
            .for_each(|v| referenced_keys_in_json(v, campaign_id, out)),
        _ => {}
    }
}

/// Replaces every asset key of `old_campaign` in `text` by the same stem under
/// `instance_id` / `new_campaign`.
pub fn rewrite_keys(
    text: &str,
    old_campaign: Uuid,
    instance_id: Uuid,
    new_campaign: Uuid,
) -> String {
    let matches = find_keys(text, old_campaign);
    if matches.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    for m in matches {
        out.push_str(&text[cursor..m.start]);
        out.push_str(&asset_key(instance_id, new_campaign, &m.stem));
        cursor = m.end;
    }
    out.push_str(&text[cursor..]);
    out
}

/// `rewrite_keys` over every string inside a JSON value.
pub fn rewrite_keys_in_json(
    value: &mut serde_json::Value,
    old_campaign: Uuid,
    instance_id: Uuid,
    new_campaign: Uuid,
) {
    match value {
        serde_json::Value::String(s) => {
            *s = rewrite_keys(s, old_campaign, instance_id, new_campaign)
        }
        serde_json::Value::Array(items) => items
            .iter_mut()
            .for_each(|v| rewrite_keys_in_json(v, old_campaign, instance_id, new_campaign)),
        serde_json::Value::Object(map) => map
            .values_mut()
            .for_each(|v| rewrite_keys_in_json(v, old_campaign, instance_id, new_campaign)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrite_keys_cases() {
        let (inst, old, new, other) = (
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        );
        let hash = "a".repeat(64);
        let key = asset_key(inst, old, &hash);
        let thumb = asset_key(inst, old, &format!("{hash}_thumb"));
        let foreign = asset_key(inst, other, &hash);
        let new_key = asset_key(inst, new, &hash);
        let new_thumb = asset_key(inst, new, &format!("{hash}_thumb"));
        // (case, input, expected)
        let cases = [
            ("whole_string_key", key.clone(), new_key.clone()),
            ("thumbnail_key", thumb.clone(), new_thumb),
            (
                "key_inside_markdown",
                format!("![map]({key}) and more"),
                format!("![map]({new_key}) and more"),
            ),
            ("other_campaign_untouched", foreign.clone(), foreign),
            (
                "short_hash_untouched",
                asset_key(inst, old, "abc"),
                asset_key(inst, old, "abc"),
            ),
            (
                "plain_text_untouched",
                "no keys".to_string(),
                "no keys".to_string(),
            ),
        ];
        for (case, input, expected) in cases {
            assert_eq!(
                rewrite_keys(&input, old, inst, new),
                expected,
                "case {case}"
            );
        }
    }
}
