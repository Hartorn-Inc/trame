//! ============================================================================
//! CONTAINER HEALTHCHECK PROBE (healthcheck.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Lets an orchestrator probe `GET /healthz` from inside the production image.
//! The runtime image is distroless: it ships no shell, `curl` or `wget`, so a
//! Docker Compose `healthcheck` has nothing to run. Without this probe the
//! Compose stack could not wait for a healthy server (`depends_on`,
//! `up --wait`) or restart one whose database connection is gone.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Loopback Only`:
//!      - `probe_healthz` connects to `127.0.0.1:{port}`, the listener the
//!        same container serves, so it never depends on DNS or a proxy.
//!   2. `Bounded Wait`:
//!      - Connect, write and read are each capped at `timeout`, so a hung
//!        server fails the probe instead of piling up probe processes.
//!   3. `Status Line Only`:
//!      - Only `HTTP/1.x 200` counts as healthy. `/healthz` answers `503`
//!        when PostgreSQL does not respond, which fails the probe.
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `trame-server healthcheck`
//!     ├── 1. Resolve the listen port like the server (`TRAME_PORT`, `PORT`, 8080).
//!     ├── 2. `GET /healthz` over HTTP/1.0 on loopback.
//!     └── 3. Exit `0` on `200`, `1` otherwise.
//! ============================================================================

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// First command-line argument that runs the probe instead of the server.
pub const HEALTHCHECK_ARG: &str = "healthcheck";

/// Per-step deadline of the probe (connect, write, read): 3 seconds.
pub const HEALTHCHECK_TIMEOUT: Duration = Duration::from_secs(3);

/// Returns `true` when `GET /healthz` on `127.0.0.1:{port}` answers `200` within `timeout`
/// for each step (module invariants 1-3).
pub fn probe_healthz(port: u16, timeout: Duration) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, timeout) else {
        return false;
    };
    if stream.set_read_timeout(Some(timeout)).is_err()
        || stream.set_write_timeout(Some(timeout)).is_err()
        || stream
            .write_all(b"GET /healthz HTTP/1.0\r\nHost: localhost\r\n\r\n")
            .is_err()
    {
        return false;
    }
    // `HTTP/1.x 200 `: the status code is always followed by a space (RFC 9112 status-line).
    let mut status_line = [0u8; 13];
    stream.read_exact(&mut status_line).is_ok()
        && status_line.starts_with(b"HTTP/1.")
        && &status_line[8..] == b" 200 "
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    /// Serves one canned `response` on an ephemeral loopback port and returns the port.
    fn serve_once(response: &'static [u8]) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            if let Ok((mut socket, _)) = listener.accept() {
                let mut request = [0u8; 256];
                let _ = socket.read(&mut request);
                let _ = socket.write_all(response);
            }
        });
        port
    }

    #[test]
    fn probe_accepts_only_a_200_status_line() {
        let cases: [(&str, &'static [u8], bool); 4] = [
            (
                "healthy_200",
                b"HTTP/1.1 200 OK\r\ncontent-length: 15\r\n\r\n{\"status\":\"ok\"}",
                true,
            ),
            (
                "database_down_503",
                b"HTTP/1.1 503 Service Unavailable\r\n\r\n",
                false,
            ),
            (
                "status_2000_is_not_200",
                b"HTTP/1.1 2000 Odd\r\n\r\n",
                false,
            ),
            ("truncated_status_line", b"HTTP/1.1 20", false),
        ];
        for (case, response, healthy) in cases {
            let port = serve_once(response);
            assert_eq!(
                probe_healthz(port, Duration::from_secs(2)),
                healthy,
                "case {case}"
            );
        }
    }

    #[test]
    fn probe_fails_when_nothing_listens() {
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        assert!(!probe_healthz(port, Duration::from_millis(500)));
    }
}
