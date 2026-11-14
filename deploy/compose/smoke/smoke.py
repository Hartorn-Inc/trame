"""
============================================================================
PRODUCTION COMPOSE SMOKE CLIENT (smoke.py)
============================================================================

PURPOSE:
--------
Drives the running production stack from outside, through Caddy only, the
way a browser would. `run-smoke.sh` calls it twice: `seed` before the backup
and `verify` after the database was wiped and restored. Standard library
only, so it runs in a stock `python:alpine` container.

INVARIANTS & SAFETY BOUNDARIES:
-------------------------------
  1. `Real TLS`:
     - Certificates are verified against Caddy's internal root CA
       (`/work/caddy-root.crt`), never with verification disabled.
  2. `Edge Contracts Checked`:
     - `/healthz` answers through Caddy; HTML is gzip-encoded exactly once
       (no second compression pass at the edge).
     - `Strict-Transport-Security: max-age=31536000` (no `preload`) reaches
       the browser through Caddy, since `TRAME_PUBLIC_ORIGIN` is `https://`.
     - The WebSocket upgrade selects `trame.v1+deflate` and the first binary
       frame (the state snapshot) is a zlib stream.
     - An uploaded map image downloads through `/assets/download` -> `307`
       -> presigned Silo URL on the public origin (the `307` carries
       `Cache-Control: private, no-store`), as `image/webp` with
       `Access-Control-Allow-Origin` for the public origin only.
  3. `Restore Proof`:
     - `verify` reuses the session cookie saved by `seed`: it only works if
       the restored database holds the same account, session and campaign.

EXECUTION LIFECYCLE:
--------------------
  `smoke.py seed`    health -> compression -> owner bootstrap -> campaign ->
                     asset upload + signed download -> WebSocket -> state.json
  `smoke.py verify`  health -> campaign listed -> fresh presign -> download
============================================================================
"""

import base64
import gzip
import hashlib
import http.client
import json
import os
import socket
import ssl
import struct
import sys
import urllib.parse
import zlib

ORIGIN = os.environ["SMOKE_ORIGIN"].rstrip("/")
SETUP_URL = os.environ.get("SMOKE_SETUP_URL", "")
CA_FILE = "/work/caddy-root.crt"
STATE_FILE = "/work/state.json"
WS_PROTOCOL = "trame.v1+deflate"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

_origin = urllib.parse.urlsplit(ORIGIN)
HOST = _origin.hostname
PORT = _origin.port or 443
TLS = ssl.create_default_context(cafile=CA_FILE)
failures = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'} {name}{'' if ok else ': ' + str(detail)}", flush=True)
    if not ok:
        failures.append(name)
    return ok


def request(method, path, body=None, headers=None):
    conn = http.client.HTTPSConnection(HOST, PORT, context=TLS, timeout=20)
    try:
        conn.request(method, path, body=body, headers={"Origin": ORIGIN, **(headers or {})})
        resp = conn.getresponse()
        return resp, resp.read()
    finally:
        conn.close()


def png_bytes(width=64, height=64):
    """A small solid-colour RGB PNG (the server transcodes uploads to WebP)."""

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    raw = b"".join(b"\x00" + b"\x40\x80\xc0" * width for _ in range(height))
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def path_of(url):
    parts = urllib.parse.urlsplit(url)
    return parts.path + (f"?{parts.query}" if parts.query else "")


def check_health():
    resp, body = request("GET", "/healthz")
    check("healthz through caddy", resp.status == 200 and b'"ok"' in body, f"{resp.status} {body[:200]!r}")
    for path in ("/healthz", "/"):
        resp, _ = request("GET", path)
        hsts = resp.getheader("Strict-Transport-Security")
        check(f"HSTS one year without preload through caddy ({path})", hsts == "max-age=31536000", hsts)


def check_signed_download(cookie, asset_url):
    resp, _ = request("GET", path_of(asset_url), headers={"Cookie": cookie})
    location = resp.getheader("Location", "")
    if not check(
        "asset download redirects to the presigned bucket URL",
        resp.status == 307 and location.startswith(f"{ORIGIN}/"),
        f"{resp.status} location={location!r}",
    ):
        return
    cache = resp.getheader("Cache-Control")
    check("signed download redirect is private, no-store", cache == "private, no-store", cache)
    resp, body = request("GET", path_of(location))
    check(
        "presigned object served as webp through caddy",
        resp.status == 200 and resp.getheader("Content-Type") == "image/webp" and body[8:12] == b"WEBP",
        f"{resp.status} {resp.getheader('Content-Type')} {body[:16]!r}",
    )
    check(
        "bucket CORS allows the public origin",
        resp.getheader("Access-Control-Allow-Origin") == ORIGIN,
        resp.getheader("Access-Control-Allow-Origin"),
    )
    check("webp not re-encoded by the edge", resp.getheader("Content-Encoding") is None, resp.getheader("Content-Encoding"))
    resp, _ = request("GET", path_of(location), headers={"Origin": "https://evil.example"})
    check(
        "bucket CORS refuses a foreign origin",
        resp.status == 200 and resp.getheader("Access-Control-Allow-Origin") is None,
        resp.getheader("Access-Control-Allow-Origin"),
    )


def read_exact(sock, n):
    data = b""
    while len(data) < n:
        part = sock.recv(n - len(data))
        if not part:
            raise ConnectionError("socket closed")
        data += part
    return data


def check_websocket(cookie, campaign_id):
    key = base64.b64encode(os.urandom(16)).decode()
    raw = socket.create_connection((HOST, PORT), timeout=20)
    sock = TLS.wrap_socket(raw, server_hostname=HOST)
    try:
        sock.sendall(
            (
                f"GET /ws/campaigns/{campaign_id} HTTP/1.1\r\nHost: {_origin.netloc}\r\n"
                "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n"
                f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Protocol: {WS_PROTOCOL}\r\n"
                f"Origin: {ORIGIN}\r\nCookie: {cookie}\r\n\r\n"
            ).encode()
        )
        head = b""
        while b"\r\n\r\n" not in head:
            head += read_exact(sock, 1)
        lines = head.decode("latin-1").split("\r\n")
        headers = {k.strip().lower(): v.strip() for k, _, v in (line.partition(":") for line in lines[1:] if line)}
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        upgraded = check(
            "websocket upgrade through caddy",
            lines[0].startswith("HTTP/1.1 101") and headers.get("sec-websocket-accept") == accept,
            lines[0],
        )
        check(
            "websocket subprotocol trame.v1+deflate selected",
            headers.get("sec-websocket-protocol") == WS_PROTOCOL,
            headers.get("sec-websocket-protocol"),
        )
        if not upgraded:
            return
        for _ in range(5):
            b0, b1 = read_exact(sock, 2)
            length = b1 & 0x7F
            if length == 126:
                length = struct.unpack(">H", read_exact(sock, 2))[0]
            elif length == 127:
                length = struct.unpack(">Q", read_exact(sock, 8))[0]
            payload = read_exact(sock, length)
            if b0 & 0x0F == 0x2:
                try:
                    inflated = zlib.decompress(payload)
                    check("first binary frame is a zlib stream", len(inflated) > 0, len(inflated))
                except zlib.error as err:
                    check("first binary frame is a zlib stream", False, err)
                break
        else:
            check("first binary frame is a zlib stream", False, "no binary frame in 5 frames")
        sock.sendall(b"\x88\x82" + b"\x00\x00\x00\x00" + struct.pack(">H", 1000))
    finally:
        sock.close()


def seed():
    check_health()
    resp, body = request("GET", "/", headers={"Accept-Encoding": "gzip"})
    encoding = resp.getheader("Content-Encoding")
    try:
        single_pass = gzip.decompress(body).lstrip().lower().startswith(b"<!doctype html")
    except OSError:
        single_pass = False
    check("SPA gzip-encoded exactly once", resp.status == 200 and encoding == "gzip" and single_pass, f"{resp.status} {encoding}")

    token = urllib.parse.parse_qs(urllib.parse.urlsplit(SETUP_URL).query).get("token", [""])[0]
    check("owner setup URL uses the public origin", SETUP_URL.startswith(f"{ORIGIN}/setup?"), SETUP_URL)
    resp, body = request(
        "POST",
        "/api/v1/instance/bootstrap",
        body=json.dumps(
            {"token": token, "email": "owner@smoke.test", "password": "smoke-owner-password-1", "display_name": "Smoke Owner"}
        ),
        headers={"Content-Type": "application/json"},
    )
    cookie = next(
        (c.split(";")[0] for c in resp.headers.get_all("Set-Cookie") or [] if c.startswith("trame_session=")), ""
    )
    if not check("owner bootstrap through the logged setup URL", resp.status == 201 and cookie, f"{resp.status} {body[:200]!r}"):
        return

    name = f"Smoke Campaign {os.urandom(3).hex()}"
    resp, body = request(
        "POST", "/api/v1/campaigns", body=json.dumps({"name": name}), headers={"Content-Type": "application/json", "Cookie": cookie}
    )
    if not check("campaign created", resp.status == 201, f"{resp.status} {body[:200]!r}"):
        return
    campaign_id = json.loads(body)["campaign"]["id"]

    resp, body = request(
        "POST", f"/api/v1/campaigns/{campaign_id}/assets", body=png_bytes(), headers={"Content-Type": "image/png", "Cookie": cookie}
    )
    if not check("map asset uploaded to the object store", resp.status == 201, f"{resp.status} {body[:200]!r}"):
        return
    uploaded = json.loads(body)
    check_signed_download(cookie, uploaded["url"])
    check_websocket(cookie, campaign_id)

    with open(STATE_FILE, "w", encoding="utf-8") as fh:
        json.dump({"cookie": cookie, "campaign_id": campaign_id, "campaign_name": name, "asset_hash": uploaded["hash"]}, fh)


def verify():
    with open(STATE_FILE, encoding="utf-8") as fh:
        state = json.load(fh)
    check_health()
    resp, body = request("GET", "/api/v1/campaigns", headers={"Cookie": state["cookie"]})
    check(
        "restored campaign visible with the pre-backup session",
        resp.status == 200 and state["campaign_id"].encode() in body and state["campaign_name"].encode() in body,
        f"{resp.status} {body[:200]!r}",
    )
    resp, body = request(
        "GET", f"/api/v1/campaigns/{state['campaign_id']}/assets/{state['asset_hash']}/presign", headers={"Cookie": state["cookie"]}
    )
    if check("restored asset presigned (same instance id)", resp.status == 200, f"{resp.status} {body[:200]!r}"):
        check_signed_download(state["cookie"], json.loads(body)["url"])


if __name__ == "__main__":
    {"seed": seed, "verify": verify}[sys.argv[1]]()
    print(f"smoke {sys.argv[1]}: {'FAILED ' + ', '.join(failures) if failures else 'all checks passed'}", flush=True)
    sys.exit(1 if failures else 0)
