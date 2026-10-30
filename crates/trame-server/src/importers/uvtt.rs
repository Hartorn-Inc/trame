use crate::assets::store::{AssetStore, AssetStoreError};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use bytes::Bytes;
use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, ImageFormat};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Cursor;
use thiserror::Error;
use trame_engine::geometry::{Point2D, WallKind, WallSegment};
use uuid::Uuid;

pub const MAX_PAYLOAD_SIZE_BYTES: usize = 67_108_864; // 64 MiB
pub const MAX_IMAGE_DIMENSION_PX: u32 = 10_000;
pub const THUMBNAIL_MAX_DIMENSION_PX: u32 = 256;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum UvttImportError {
    #[error("Payload size {0} exceeds 64 MiB limit")]
    PayloadTooLarge(usize),
    #[error("Invalid JSON payload: {0}")]
    InvalidJson(String),
    #[error("Invalid base64 image data: {0}")]
    InvalidBase64(String),
    #[error("Unsupported or missing image magic bytes")]
    InvalidMagicBytes,
    #[error("Failed to decode raster image: {0}")]
    ImageDecodeFailure(String),
    #[error("Image dimension {width}x{height} exceeds max 10000x10000 limit")]
    ImageDimensionExceeded { width: u32, height: u32 },
    #[error("Failed to encode WebP image: {0}")]
    ImageEncodeFailure(String),
    #[error("Storage failure: {0}")]
    Storage(String),
}

impl From<AssetStoreError> for UvttImportError {
    fn from(err: AssetStoreError) -> Self {
        Self::Storage(err.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UvttResolution {
    pub map_origin: UvttPoint,
    pub map_size: UvttPoint,
    pub pixels_per_grid: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct UvttPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UvttPortal {
    pub position: UvttPoint,
    pub bounds: Vec<UvttPoint>,
    #[serde(default)]
    pub rotation: f64,
    pub closed: bool,
    #[serde(default)]
    pub freestanding: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UvttLight {
    pub position: UvttPoint,
    pub range: f64,
    pub color: String,
    pub intensity: f64,
    #[serde(default)]
    pub shadows: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UvttDocument {
    pub format: f64,
    pub resolution: UvttResolution,
    pub image: String,
    #[serde(default)]
    pub line_of_sight: Vec<Vec<UvttPoint>>,
    #[serde(default)]
    pub objects_line_of_sight: Vec<Vec<UvttPoint>>,
    #[serde(default)]
    pub portals: Vec<UvttPortal>,
    #[serde(default)]
    pub lights: Vec<UvttLight>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImportedLightSource {
    pub id: Uuid,
    pub position: Point2D,
    pub bright_radius_px: f64,
    pub dim_radius_px: f64,
    pub color_rgb: [f32; 3],
    pub intensity: f64,
    pub shadows: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImportedMapResult {
    pub image_asset_key: String,
    pub thumbnail_asset_key: String,
    pub sha256_hash: String,
    pub width_px: u32,
    pub height_px: u32,
    pub pixels_per_grid: f64,
    pub grid_cols: f64,
    pub grid_rows: f64,
    pub walls: Vec<WallSegment>,
    pub lights: Vec<ImportedLightSource>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DetectedImageFormat {
    Png,
    Jpeg,
    Webp,
}

fn detect_magic_bytes(bytes: &[u8]) -> Result<DetectedImageFormat, UvttImportError> {
    if bytes.len() >= 8 && bytes[0..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] {
        return Ok(DetectedImageFormat::Png);
    }
    if bytes.len() >= 4 && bytes[0..4] == [0x89, 0x50, 0x4E, 0x47] {
        return Ok(DetectedImageFormat::Png);
    }
    if bytes.len() >= 3 && bytes[0..3] == [0xFF, 0xD8, 0xFF] {
        return Ok(DetectedImageFormat::Jpeg);
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Ok(DetectedImageFormat::Webp);
    }
    Err(UvttImportError::InvalidMagicBytes)
}

pub fn parse_hex_color(hex_str: &str) -> [f32; 3] {
    let trimmed = hex_str.trim().trim_start_matches('#');
    if !trimmed.is_ascii() {
        return [1.0, 1.0, 1.0];
    }
    match trimmed.len() {
        6 => {
            let r = u8::from_str_radix(&trimmed[0..2], 16).unwrap_or(255);
            let g = u8::from_str_radix(&trimmed[2..4], 16).unwrap_or(255);
            let b = u8::from_str_radix(&trimmed[4..6], 16).unwrap_or(255);
            [r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0]
        }
        8 => {
            // Formats: AARRGGBB or RRGGBBAA; standard dd2vtt uses AARRGGBB
            let r = u8::from_str_radix(&trimmed[2..4], 16).unwrap_or(255);
            let g = u8::from_str_radix(&trimmed[4..6], 16).unwrap_or(255);
            let b = u8::from_str_radix(&trimmed[6..8], 16).unwrap_or(255);
            [r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0]
        }
        3 => {
            let r = u8::from_str_radix(&trimmed[0..1].repeat(2), 16).unwrap_or(255);
            let g = u8::from_str_radix(&trimmed[1..2].repeat(2), 16).unwrap_or(255);
            let b = u8::from_str_radix(&trimmed[2..3].repeat(2), 16).unwrap_or(255);
            [r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0]
        }
        _ => [1.0, 1.0, 1.0],
    }
}

pub fn parse_uvtt_geometry(doc: &UvttDocument) -> (Vec<WallSegment>, Vec<ImportedLightSource>) {
    let ppg = doc.resolution.pixels_per_grid.max(1.0);
    let mut walls = Vec::new();

    // 1. Line of Sight (solid walls)
    for polyline in &doc.line_of_sight {
        for window in polyline.windows(2) {
            let a = Point2D::new(window[0].x * ppg, window[0].y * ppg);
            let b = Point2D::new(window[1].x * ppg, window[1].y * ppg);
            walls.push(WallSegment {
                id: Uuid::new_v4(),
                a,
                b,
                kind: WallKind::Normal,
                blocks_movement: true,
                blocks_vision: true,
                blocks_light: true,
                blocks_sound: true,
                bottom_elevation_ft: -1000.0,
                top_elevation_ft: 1000.0,
            });
        }
    }

    // 2. Objects Line of Sight (low obstacles / terrain)
    for polyline in &doc.objects_line_of_sight {
        for window in polyline.windows(2) {
            let a = Point2D::new(window[0].x * ppg, window[0].y * ppg);
            let b = Point2D::new(window[1].x * ppg, window[1].y * ppg);
            walls.push(WallSegment {
                id: Uuid::new_v4(),
                a,
                b,
                kind: WallKind::Terrain,
                blocks_movement: true,
                blocks_vision: true,
                blocks_light: true,
                blocks_sound: true,
                bottom_elevation_ft: 0.0,
                top_elevation_ft: 4.0,
            });
        }
    }

    // 3. Portals (doors)
    for portal in &doc.portals {
        if portal.bounds.len() >= 2 {
            let a = Point2D::new(portal.bounds[0].x * ppg, portal.bounds[0].y * ppg);
            let b = Point2D::new(portal.bounds[1].x * ppg, portal.bounds[1].y * ppg);
            let is_open = !portal.closed;
            walls.push(WallSegment {
                id: Uuid::new_v4(),
                a,
                b,
                kind: WallKind::Door {
                    is_open,
                    is_locked: false,
                },
                blocks_movement: !is_open,
                blocks_vision: !is_open,
                blocks_light: !is_open,
                blocks_sound: !is_open,
                bottom_elevation_ft: -1000.0,
                top_elevation_ft: 1000.0,
            });
        }
    }

    // 4. Lights
    let mut lights = Vec::new();
    for light in &doc.lights {
        let position = Point2D::new(light.position.x * ppg, light.position.y * ppg);
        let bright_radius_px = (light.range / 2.0) * ppg;
        let dim_radius_px = light.range * ppg;
        let color_rgb = parse_hex_color(&light.color);
        lights.push(ImportedLightSource {
            id: Uuid::new_v4(),
            position,
            bright_radius_px,
            dim_radius_px,
            color_rgb,
            intensity: light.intensity.max(0.0),
            shadows: light.shadows,
        });
    }

    (walls, lights)
}

/// Ingests a raw Universal VTT (.uvtt / .dd2vtt) byte stream, enforces security limits,
/// converts raster graphics to canonical WebP + thumbnail, persists assets, and maps geometry.
pub async fn import_uvtt_map<S: AssetStore + ?Sized>(
    payload: &[u8],
    instance_id: Uuid,
    campaign_id: Uuid,
    store: &S,
) -> Result<ImportedMapResult, UvttImportError> {
    if payload.len() > MAX_PAYLOAD_SIZE_BYTES {
        return Err(UvttImportError::PayloadTooLarge(payload.len()));
    }

    let doc: UvttDocument =
        serde_json::from_slice(payload).map_err(|e| UvttImportError::InvalidJson(e.to_string()))?;

    let cleaned_base64: String = doc.image.chars().filter(|c| !c.is_whitespace()).collect();

    let raw_image_bytes = BASE64
        .decode(&cleaned_base64)
        .map_err(|e| UvttImportError::InvalidBase64(e.to_string()))?;

    let _detected_format = detect_magic_bytes(&raw_image_bytes)?;

    let decoded_img: DynamicImage = image::load_from_memory(&raw_image_bytes)
        .map_err(|e| UvttImportError::ImageDecodeFailure(e.to_string()))?;

    let (width, height) = decoded_img.dimensions();
    if width > MAX_IMAGE_DIMENSION_PX || height > MAX_IMAGE_DIMENSION_PX {
        return Err(UvttImportError::ImageDimensionExceeded { width, height });
    }

    // Encode primary map image as WebP (or fallback to PNG if WebP writer unsupported)
    let primary_bytes = encode_image(&decoded_img, ImageFormat::WebP)?;

    // Compute SHA-256 content address digest
    let mut hasher = Sha256::new();
    hasher.update(&primary_bytes);
    let hash_hex = format!("{:x}", hasher.finalize());

    // Generate 256px maximum dimension thumbnail preserving aspect ratio
    let thumb_img = decoded_img.resize(
        THUMBNAIL_MAX_DIMENSION_PX,
        THUMBNAIL_MAX_DIMENSION_PX,
        FilterType::Lanczos3,
    );
    let thumb_bytes = encode_image(&thumb_img, ImageFormat::WebP)?;

    let primary_key =
        format!("instances/{instance_id}/campaigns/{campaign_id}/assets/{hash_hex}.webp");
    let thumb_key =
        format!("instances/{instance_id}/campaigns/{campaign_id}/assets/{hash_hex}_thumb.webp");

    store
        .put_asset(&primary_key, Bytes::from(primary_bytes), "image/webp")
        .await
        .map_err(|e| UvttImportError::Storage(e.to_string()))?;

    store
        .put_asset(&thumb_key, Bytes::from(thumb_bytes), "image/webp")
        .await
        .map_err(|e| UvttImportError::Storage(e.to_string()))?;

    let (walls, lights) = parse_uvtt_geometry(&doc);

    Ok(ImportedMapResult {
        image_asset_key: primary_key,
        thumbnail_asset_key: thumb_key,
        sha256_hash: hash_hex,
        width_px: width,
        height_px: height,
        pixels_per_grid: doc.resolution.pixels_per_grid.max(1.0),
        grid_cols: doc.resolution.map_size.x,
        grid_rows: doc.resolution.map_size.y,
        walls,
        lights,
    })
}

fn encode_image(img: &DynamicImage, format: ImageFormat) -> Result<Vec<u8>, UvttImportError> {
    let mut buf = Vec::new();
    let mut cursor = Cursor::new(&mut buf);
    match img.write_to(&mut cursor, format) {
        Ok(()) => Ok(buf),
        Err(_) => {
            // Pure-rust fallback to PNG if container encoder rejects WebP write
            let mut fallback_buf = Vec::new();
            let mut fallback_cursor = Cursor::new(&mut fallback_buf);
            img.write_to(&mut fallback_cursor, ImageFormat::Png)
                .map_err(|e| UvttImportError::ImageEncodeFailure(e.to_string()))?;
            Ok(fallback_buf)
        }
    }
}
