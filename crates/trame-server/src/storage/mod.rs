//! Storage abstraction and backends (Local filesystem & S3/R2).

pub mod blob;
pub mod local;
pub mod s3;

pub use blob::{
    AssetDescriptor, BlobStore, BlobStoreError, BlobStream, CHUNK_SIZE, Sha256Hasher,
    slice_to_stream, stream_to_bytes,
};
pub use local::LocalFsStore;
pub use s3::{S3Config, S3Store};

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use futures_util::StreamExt;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn make_test_temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("trame_blob_test_{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create test temp dir");
        dir
    }

    #[test]
    fn sha256_hasher_matches_fips_test_vectors() {
        assert_eq!(
            Sha256Hasher::digest(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            Sha256Hasher::digest(b"hello world"),
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
        assert_eq!(
            Sha256Hasher::digest(b"The quick brown fox jumps over the lazy dog"),
            "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592"
        );

        let mut incremental = Sha256Hasher::new();
        incremental.update(b"The quick ");
        incremental.update(b"brown fox ");
        incremental.update(b"jumps over the lazy dog");
        assert_eq!(
            incremental.finalize_hex(),
            "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592"
        );
    }

    #[tokio::test]
    async fn local_fs_store_atomic_put_stream_writes_to_assets_dir() {
        let temp_dir = make_test_temp_dir();
        let store = LocalFsStore::new(&temp_dir);
        let payload = b"RIFF....WEBPVP8X....sample_battlemap_data";
        let asset_id = "battlemap-dungeon-1";

        let desc = store
            .put_stream(asset_id, slice_to_stream(payload))
            .await
            .expect("put_stream succeeds");

        assert_eq!(desc.id, asset_id);
        assert_eq!(desc.byte_size, payload.len() as u64);
        assert_eq!(desc.mime_type, "image/webp");
        assert_eq!(desc.sha256_hex, Sha256Hasher::digest(payload));

        let expected_file = temp_dir.join("assets").join(format!("{asset_id}.webp"));
        assert!(expected_file.exists());
        let read_back = tokio::fs::read(&expected_file).await.unwrap();
        assert_eq!(read_back, payload);

        let mut dir_entries = tokio::fs::read_dir(temp_dir.join("assets")).await.unwrap();
        let mut files = Vec::new();
        while let Some(entry) = dir_entries.next_entry().await.unwrap() {
            files.push(entry.file_name().to_string_lossy().to_string());
        }
        assert_eq!(files, vec![format!("{asset_id}.webp")]);

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[tokio::test]
    async fn local_fs_store_atomic_write_cleans_up_temp_file_on_stream_failure() {
        let temp_dir = make_test_temp_dir();
        let store = LocalFsStore::new(&temp_dir);
        let asset_id = "failed-upload";

        let error_stream: BlobStream = Box::pin(futures_util::stream::iter(vec![
            Ok(Bytes::from_static(b"initial_chunk_")),
            Err(BlobStoreError::S3(
                "network connection severed mid-stream".to_string(),
            )),
        ]));

        let result = store.put_stream(asset_id, error_stream).await;
        assert!(result.is_err());

        let dest_file = temp_dir.join("assets").join(format!("{asset_id}.webp"));
        assert!(!dest_file.exists());

        let mut dir_entries = tokio::fs::read_dir(temp_dir.join("assets")).await.unwrap();
        let mut remaining = Vec::new();
        while let Some(entry) = dir_entries.next_entry().await.unwrap() {
            remaining.push(entry.file_name().to_string_lossy().to_string());
        }
        assert!(
            remaining.is_empty(),
            "Temporary files must be deleted on stream error"
        );

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[tokio::test]
    async fn local_fs_store_get_descriptor_and_not_found() {
        let temp_dir = make_test_temp_dir();
        let store = LocalFsStore::new(&temp_dir);
        let payload = b"token_alpha_bytes";
        let asset_id = "token-alpha";

        store
            .put_stream(asset_id, slice_to_stream(payload))
            .await
            .unwrap();

        let desc = store.get_descriptor(asset_id).await.unwrap();
        assert_eq!(desc.id, asset_id);
        assert_eq!(desc.byte_size, payload.len() as u64);
        assert_eq!(desc.sha256_hex, Sha256Hasher::digest(payload));
        assert_eq!(desc.mime_type, "image/webp");

        let non_existent = store.get_descriptor("missing-token").await;
        assert_eq!(
            non_existent.unwrap_err(),
            BlobStoreError::NotFound("missing-token".to_string())
        );

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[tokio::test]
    async fn local_fs_store_open_read_stream_returns_not_found_or_64_kib_chunks() {
        let temp_dir = make_test_temp_dir();
        let store = LocalFsStore::new(&temp_dir);

        let not_found_err = match store.open_read_stream("non-existent").await {
            Err(err) => err,
            Ok(_) => panic!("expected open_read_stream on non-existent to fail"),
        };
        assert_eq!(
            not_found_err,
            BlobStoreError::NotFound("non-existent".to_string())
        );

        let large_size = 150 * 1024;
        let large_payload: Vec<u8> = (0..large_size).map(|i| (i % 251) as u8).collect();
        let asset_id = "large-map";

        store
            .put_stream(asset_id, slice_to_stream(&large_payload))
            .await
            .unwrap();

        let mut stream = store.open_read_stream(asset_id).await.unwrap();
        let mut chunks = Vec::new();
        while let Some(chunk_res) = stream.next().await {
            chunks.push(chunk_res.unwrap());
        }

        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].len(), 64 * 1024);
        assert_eq!(chunks[1].len(), 64 * 1024);
        assert_eq!(chunks[2].len(), 22 * 1024);

        let reconstituted: Vec<u8> = chunks.into_iter().flat_map(|c| c.to_vec()).collect();
        assert_eq!(reconstituted, large_payload);

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[tokio::test]
    async fn s3_store_put_stream_streams_chunks_to_target_bucket() {
        let config = S3Config {
            endpoint: "https://r2.cloudflarestorage.com".to_string(),
            bucket: "trame-campaign-prod".to_string(),
            access_key_id: "test-key".to_string(),
            secret_access_key: "test-secret".to_string(),
            region: "auto".to_string(),
            prefix: Some("assets".to_string()),
        };
        let store = S3Store::new(config.clone());

        let data: Vec<u8> = (0..140 * 1024).map(|i| (i % 256) as u8).collect();
        let asset_id = "s3-dungeon-layer";

        let desc = store
            .put_stream(asset_id, slice_to_stream(&data))
            .await
            .unwrap();

        assert_eq!(desc.id, asset_id);
        assert_eq!(desc.byte_size, data.len() as u64);
        assert_eq!(desc.sha256_hex, Sha256Hasher::digest(&data));

        let chunk_sizes = store.streamed_chunk_sizes(asset_id).await.unwrap();
        assert_eq!(chunk_sizes.len(), 3);
        assert_eq!(chunk_sizes[0], 64 * 1024);
        assert_eq!(chunk_sizes[1], 64 * 1024);
        assert_eq!(chunk_sizes[2], 12 * 1024);

        let read_stream = store.open_read_stream(asset_id).await.unwrap();
        let recovered = stream_to_bytes(read_stream).await.unwrap();
        assert_eq!(recovered.as_ref(), data.as_slice());
    }

    #[tokio::test]
    async fn list_descriptors_returns_all_stored_items_for_local_and_s3() {
        let temp_dir = make_test_temp_dir();
        let local_store = LocalFsStore::new(&temp_dir);
        let s3_store = S3Store::new(S3Config::default());

        let asset_ids = ["asset-c", "asset-a", "asset-b"];
        for id in asset_ids {
            let payload = format!("content-for-{id}").into_bytes();
            local_store
                .put_stream(id, slice_to_stream(&payload))
                .await
                .unwrap();
            s3_store
                .put_stream(id, slice_to_stream(&payload))
                .await
                .unwrap();
        }

        let local_list = local_store.list_descriptors().await.unwrap();
        assert_eq!(local_list.len(), 3);
        assert_eq!(local_list[0].id, "asset-a");
        assert_eq!(local_list[1].id, "asset-b");
        assert_eq!(local_list[2].id, "asset-c");

        let s3_list = s3_store.list_descriptors().await.unwrap();
        assert_eq!(s3_list.len(), 3);
        assert_eq!(s3_list[0].id, "asset-a");
        assert_eq!(s3_list[1].id, "asset-b");
        assert_eq!(s3_list[2].id, "asset-c");

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[tokio::test]
    async fn path_traversal_attempts_are_strictly_rejected() {
        let temp_dir = make_test_temp_dir();
        let store = LocalFsStore::new(&temp_dir);
        let bad_ids = ["../etc/passwd", "sub/dir", "..\\windows\\system32", ""];

        for id in bad_ids {
            let err = store
                .put_stream(id, slice_to_stream(b"malicious"))
                .await
                .unwrap_err();
            assert!(matches!(err, BlobStoreError::InvalidArgument(_)));
        }

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }
}
