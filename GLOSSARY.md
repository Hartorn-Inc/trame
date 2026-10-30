# GLOSSARY

| Term | Description |
| --- | --- |
| UVTT | Universal VTT format (`.uvtt` / `.dd2vtt`), a JSON file containing map metadata, base64-encoded image data, grid definitions, line of sight segments, portals, and lights. |
| AssetStore | Asynchronous storage abstraction trait providing object persistence and pre-signed URL generation. |
| WallSegment | Vector line segment entity defining collision, vision obstruction, light obstruction, and sound obstruction boundaries. |
| WallKind | Enumeration of wall segment behavioral variants: `Normal`, `Terrain`, or `Door`. |
| Door | A `WallKind` variant representing an interactive portal with state flags `is_open` and `is_locked`. |
| LightSource | Point light emission source in the scene with bright and dim radius, intensity, and color properties. |
| Presigned URL | A time-limited signed cryptographic URL granting temporary read access to an object stored in Cloudflare R2 or S3-compatible object storage. |
| Content-Addressable Storage (CAS) | Storage strategy indexing assets by the cryptographic SHA-256 hash digest of their canonical content. |
| RBAC | Role-Based Access Control enforcing campaign authorization before granting map mutation or asset URL issuance. |