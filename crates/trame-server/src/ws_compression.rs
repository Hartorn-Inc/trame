//! ============================================================================
//! WEBSOCKET FRAME COMPRESSION (ws_compression.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Shrinks the binary MessagePack frames the campaign WebSocket sends (D24,
//! SEC20). A `StateSnapshot` carries every wall, light and token of the scene,
//! so a resync or a reconnect after a deploy ships the whole projection again.
//! MessagePack keeps field names (`to_vec_named`), which deflate removes well.
//!
//! WHY NOT STANDARD `permessage-deflate` (D24 SPIKE OUTCOME):
//! ----------------------------------------------------------
//! `tungstenite` 0.28-0.30 and `tokio-tungstenite` 0.29-0.30 (axum 0.8.9 uses
//! 0.29) ship no `deflate` feature: frames with the RSV1 bit are rejected and
//! no extension can be negotiated. Standard `permessage-deflate` therefore
//! needs a third-party WebSocket crate, which D24 rules out. The fallback is
//! the application-level codec in this module.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Opt-In Subprotocol`:
//!      - The browser offers `Sec-WebSocket-Protocol: trame.v1+deflate` only
//!        when it has `DecompressionStream`. The upgrade echoes the protocol
//!        back, and only then is every outbound binary frame compressed. A
//!        client that offers nothing gets plain frames.
//!   2. `One Self-Contained zlib Stream Per Frame`:
//!      - Each frame is an independent RFC 1950 zlib stream (`deflate` format
//!        of `DecompressionStream`). No dictionary carries over between
//!        frames, so a frame never compresses against data from another one.
//!   3. `Server-To-Client Only`:
//!      - Client frames (commands, pings) stay uncompressed, so the server
//!        never inflates untrusted input: no decompression bomb can reach it.
//!   4. `Bounded CPU`:
//!      - Level 1 (`Compression::fast()`), run in the per-socket writer task,
//!        never inside the room actor, so a slow compression delays only the
//!        socket it belongs to.
//!   5. `BREACH Exposure`:
//!      - Frames carry no credentials or signed URLs: the session cookie
//!        travels only in the upgrade request, so high-value secrets are never
//!        compressed in WebSocket frames.
//!      - Per-recipient redaction strips hidden tokens and unrevealed fog
//!        before serialization, preventing a player from measuring hidden
//!        table state on their own socket.
//!      - Residual risk, accepted: an outbound frame for the GM (or another
//!        player with differing fog of war) mixes recipient-visible table
//!        strings with player-controlled strings (such as a player's own token
//!        name). An attacker able to observe another recipient's encrypted
//!        frame lengths — including on shared in-person Wi-Fi via 802.11 frame
//!        sizes, not solely on the GM's WAN path, and between players with
//!        differing fog — has a bounded compression-length side channel
//!        limited to table strings, never credentials or signed URLs.
//! ============================================================================

use std::io::Write;

use axum::http::HeaderValue;
use flate2::Compression;
use flate2::write::ZlibEncoder;

/// WebSocket subprotocol by which a client asks for zlib-compressed binary frames.
pub const WS_SUBPROTOCOL_DEFLATE: &str = "trame.v1+deflate";

/// Encoding applied to every outbound binary frame of one socket, fixed at the upgrade.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameEncoding {
    /// No subprotocol was negotiated: frames go out as plain MessagePack.
    Identity,
    /// `trame.v1+deflate` was negotiated: each frame is one zlib stream (invariant 2).
    Deflate,
}

impl FrameEncoding {
    /// Encoding for the subprotocol the upgrade selected (`WebSocket::protocol()`).
    pub fn from_selected_protocol(protocol: Option<&HeaderValue>) -> Self {
        match protocol {
            Some(p) if p.as_bytes() == WS_SUBPROTOCOL_DEFLATE.as_bytes() => Self::Deflate,
            _ => Self::Identity,
        }
    }

    /// Encodes one outbound binary frame.
    pub fn encode(self, frame: Vec<u8>) -> Vec<u8> {
        match self {
            Self::Identity => frame,
            Self::Deflate => {
                let mut encoder =
                    ZlibEncoder::new(Vec::with_capacity(frame.len() / 4), Compression::fast());
                encoder
                    .write_all(&frame)
                    .and_then(|()| encoder.finish())
                    .expect("writing into a Vec cannot fail")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::ZlibDecoder;
    use std::io::Read;

    #[test]
    fn selected_protocol_picks_the_frame_encoding() {
        // (case_id, protocol selected by the upgrade, expected encoding)
        let cases = [
            ("no_subprotocol_is_identity", None, FrameEncoding::Identity),
            (
                "deflate_subprotocol_is_deflate",
                Some(WS_SUBPROTOCOL_DEFLATE),
                FrameEncoding::Deflate,
            ),
            (
                "unknown_subprotocol_is_identity",
                Some("trame.v2+brotli"),
                FrameEncoding::Identity,
            ),
        ];
        for (case, protocol, expected) in cases {
            let header = protocol.map(HeaderValue::from_static);
            assert_eq!(
                FrameEncoding::from_selected_protocol(header.as_ref()),
                expected,
                "case {case}"
            );
        }
    }

    #[test]
    fn deflate_frames_inflate_back_to_the_original() {
        let repetitive: Vec<u8> = b"walls".repeat(2_000);
        // (case_id, frame)
        let cases = [
            ("empty_frame", Vec::new()),
            ("tiny_frame", vec![0x81, 0xa4, b'P', b'o', b'n', b'g']),
            ("repetitive_frame", repetitive),
        ];
        for (case, frame) in cases {
            let encoded = FrameEncoding::Deflate.encode(frame.clone());
            let mut inflated = Vec::new();
            ZlibDecoder::new(encoded.as_slice())
                .read_to_end(&mut inflated)
                .unwrap_or_else(|e| panic!("case {case}: {e}"));
            assert_eq!(inflated, frame, "case {case}");
            assert_eq!(
                FrameEncoding::Identity.encode(frame.clone()),
                frame,
                "case {case}: identity"
            );
        }
    }
}
