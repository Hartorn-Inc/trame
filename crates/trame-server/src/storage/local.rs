//! Local filesystem implementation of `BlobStore` with atomic writes via temporary files.

use super::blob::{
    AssetDescriptor, BlobStore, BlobStoreError, BlobStream, CHUNK_SIZE, Sha256Hasher,
    sanitize_asset_id,
};
use bytes::Bytes;
use futures_util::{StreamExt, stream};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::RwLock;
use uuid::Uuid;

/// Filesystem-backed blob store persisting `.webp` assets under `<DATA_DIR>/assets/<id>.webp`.
#[derive(Clone)]
pub struct LocalFsStore {
    data_dir: PathBuf,
    assets_dir: PathBuf,
    descriptors: Arc<RwLock<HashMap<String, AssetDescriptor>>>,
}

impl LocalFsStore {
    /// Creates a new `LocalFsStore` rooted at `data_dir`.
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        let data_dir = data_dir.into();
        let assets_dir = data_dir.join("assets");
        Self {
            data_dir,
            assets_dir,
            descriptors: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn assets_dir(&self) -> &Path {
        &self.assets_dir
    }

    fn resolve_dest_path(&self, clean_id: &str) -> PathBuf {
        self.assets_dir.join(format!("{clean_id}.webp"))
    }

    async fn compute_file_descriptor(
        &self,
        clean_id: &str,
        path: &Path,
    ) -> Result<AssetDescriptor, BlobStoreError> {
        let mut file = match tokio::fs::File::open(path).await {
            Ok(f) => f,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Err(BlobStoreError::NotFound(clean_id.to_string()));
            }
            Err(err) => return Err(BlobStoreError::Io(err)),
        };

        let mut hasher = Sha256Hasher::new();
        let mut byte_size = 0u64;
        let mut buffer = vec![0u8; CHUNK_SIZE];

        loop {
            let bytes_read = file.read(&mut buffer).await?;
            if bytes_read == 0 {
                break;
            }
            hasher.update(&buffer[..bytes_read]);
            byte_size += bytes_read as u64;
        }

        let descriptor = AssetDescriptor {
            id: clean_id.to_string(),
            byte_size,
            sha256_hex: hasher.finalize_hex(),
            mime_type: "image/webp".to_string(),
        };
        Ok(descriptor)
    }
}

impl BlobStore for LocalFsStore {
    async fn put_stream(
        &self,
        id: &str,
        mut stream: BlobStream,
    ) -> Result<AssetDescriptor, BlobStoreError> {
        let clean_id = sanitize_asset_id(id)?;
        tokio::fs::create_dir_all(&self.assets_dir).await?;

        let dest_path = self.resolve_dest_path(&clean_id);
        let temp_filename = format!(".tmp_{}_{}.webp", clean_id, Uuid::new_v4());
        let temp_path = self.assets_dir.join(temp_filename);

        let mut file = match tokio::fs::File::create(&temp_path).await {
            Ok(f) => f,
            Err(err) => return Err(BlobStoreError::Io(err)),
        };

        let mut hasher = Sha256Hasher::new();
        let mut byte_size = 0u64;

        while let Some(chunk_res) = stream.next().await {
            let chunk = match chunk_res {
                Ok(c) => c,
                Err(err) => {
                    let _ = tokio::fs::remove_file(&temp_path).await;
                    return Err(err);
                }
            };
            if chunk.is_empty() {
                continue;
            }
            if let Err(err) = file.write_all(&chunk).await {
                let _ = tokio::fs::remove_file(&temp_path).await;
                return Err(BlobStoreError::Io(err));
            }
            hasher.update(&chunk);
            byte_size += chunk.len() as u64;
        }

        if let Err(err) = file.flush().await {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(BlobStoreError::Io(err));
        }
        drop(file);

        if let Err(err) = tokio::fs::rename(&temp_path, &dest_path).await {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(BlobStoreError::Io(err));
        }

        let descriptor = AssetDescriptor {
            id: clean_id.clone(),
            byte_size,
            sha256_hex: hasher.finalize_hex(),
            mime_type: "image/webp".to_string(),
        };

        self.descriptors
            .write()
            .await
            .insert(clean_id, descriptor.clone());
        Ok(descriptor)
    }

    async fn get_descriptor(&self, id: &str) -> Result<AssetDescriptor, BlobStoreError> {
        let clean_id = sanitize_asset_id(id)?;
        let dest_path = self.resolve_dest_path(&clean_id);

        let metadata = match tokio::fs::metadata(&dest_path).await {
            Ok(m) => m,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                self.descriptors.write().await.remove(&clean_id);
                return Err(BlobStoreError::NotFound(id.to_string()));
            }
            Err(err) => return Err(BlobStoreError::Io(err)),
        };

        if let Some(cached) = self.descriptors.read().await.get(&clean_id)
            && cached.byte_size == metadata.len()
        {
            return Ok(cached.clone());
        }

        let computed = self.compute_file_descriptor(&clean_id, &dest_path).await?;
        self.descriptors
            .write()
            .await
            .insert(clean_id, computed.clone());
        Ok(computed)
    }

    async fn open_read_stream(&self, id: &str) -> Result<BlobStream, BlobStoreError> {
        let clean_id = sanitize_asset_id(id)?;
        let dest_path = self.resolve_dest_path(&clean_id);

        let file = match tokio::fs::File::open(&dest_path).await {
            Ok(f) => f,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Err(BlobStoreError::NotFound(id.to_string()));
            }
            Err(err) => return Err(BlobStoreError::Io(err)),
        };

        let stream = stream::unfold(Some(file), |state| async move {
            let mut file = state?;
            let mut buffer = vec![0u8; CHUNK_SIZE];
            match file.read(&mut buffer).await {
                Ok(0) => None,
                Ok(bytes_read) => {
                    buffer.truncate(bytes_read);
                    Some((Ok(Bytes::from(buffer)), Some(file)))
                }
                Err(err) => Some((Err(BlobStoreError::Io(err)), None)),
            }
        });

        Ok(Box::pin(stream))
    }

    async fn list_descriptors(&self) -> Result<Vec<AssetDescriptor>, BlobStoreError> {
        if !tokio::fs::try_exists(&self.assets_dir)
            .await
            .unwrap_or(false)
        {
            return Ok(Vec::new());
        }

        let mut entries = tokio::fs::read_dir(&self.assets_dir).await?;
        let mut descriptors = Vec::new();

        while let Some(entry) = entries.next_entry().await? {
            let file_type = entry.file_type().await?;
            if !file_type.is_file() {
                continue;
            }
            let file_name = entry.file_name();
            let file_name_str = file_name.to_string_lossy();
            if file_name_str.starts_with('.') {
                continue;
            }
            if let Some(clean_id) = file_name_str.strip_suffix(".webp")
                && let Ok(desc) = self.get_descriptor(clean_id).await
            {
                descriptors.push(desc);
            }
        }

        descriptors.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(descriptors)
    }

    async fn delete(&self, id: &str) -> Result<(), BlobStoreError> {
        let clean_id = sanitize_asset_id(id)?;
        let dest_path = self.resolve_dest_path(&clean_id);
        match tokio::fs::remove_file(&dest_path).await {
            Ok(_) => {
                self.descriptors.write().await.remove(&clean_id);
                Ok(())
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                Err(BlobStoreError::NotFound(id.to_string()))
            }
            Err(err) => Err(BlobStoreError::Io(err)),
        }
    }
}
