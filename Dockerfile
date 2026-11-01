# TRAME Production Multi-Stage Single Binary Image (Cloud Run / e2-micro)
#
# Stages:
#   1. rust-source   Pinned toolchain + locked workspace sources (shared by 2 and 3).
#   2. wasm-builder  wasm-pack builds crates/trame-engine into packages/web/src/wasm.
#   3. rust-builder  `cargo build --release --locked` for the trame-server binary.
#   4. web-builder   `npm ci && npm run build` emits the SPA into packages/web/dist.
#   5. runtime       distroless image: one binary on port 8080 plus the SPA under
#                    TRAME_STATIC_DIR. `/api` and `/ws` stay served by the same binary.
#
# The Rust tag must match `channel` in `rust-toolchain.toml`; the Node tag must
# match the `web-dev` service in `docker-compose.dev.yml`.

FROM rust:1.99.1-bookworm AS rust-source
WORKDIR /build
COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
COPY crates ./crates

FROM rust-source AS wasm-builder
ARG WASM_PACK_VERSION=0.15.1
RUN apt-get update && apt-get install -y --no-install-recommends binaryen \
    && rm -rf /var/lib/apt/lists/*
RUN curl -sSfL "https://github.com/wasm-bindgen/wasm-pack/releases/download/v${WASM_PACK_VERSION}/wasm-pack-v${WASM_PACK_VERSION}-$(uname -m)-unknown-linux-musl.tar.gz" \
    | tar -xz --strip-components=1 -C /usr/local/cargo/bin "wasm-pack-v${WASM_PACK_VERSION}-$(uname -m)-unknown-linux-musl/wasm-pack"
RUN wasm-pack build crates/trame-engine --release --target web --out-dir ../../packages/web/src/wasm

FROM rust-source AS rust-builder
RUN cargo build --release --locked --bin trame-server

FROM node:24-bookworm-slim AS web-builder
WORKDIR /build/packages/web
COPY packages/web/package.json packages/web/package-lock.json ./
RUN npm ci
COPY packages/web ./
COPY packages/game-systems ../game-systems
COPY --from=wasm-builder /build/packages/web/src/wasm ./src/wasm
RUN npm run build

FROM gcr.io/distroless/cc-debian12:nonroot
WORKDIR /app
COPY --from=rust-builder /build/target/release/trame-server /app/trame-server
COPY --from=web-builder /build/packages/web/dist /app/static
ENV TRAME_STATIC_DIR=/app/static
EXPOSE 8080
ENTRYPOINT ["/app/trame-server"]
