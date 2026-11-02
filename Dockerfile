# TRAME Production Multi-Stage Single Binary Image (Cloud Run / e2-micro)
#
# Stages:
#   1. rust-source   Pinned toolchain + locked workspace sources (shared by 2 and 3).
#   2. wasm-builder  wasm-pack builds crates/trame-engine for the browser
#                    (packages/web/src/wasm). wasm-opt stays disabled through
#                    crates/trame-engine/Cargo.toml.
#   3. rust-builder  `cargo build --release --locked` for the trame-server binary.
#   4. web-builder   type-checks the app sources only (tsconfig.build.json; tests are
#                    checked by CI and `make lint-web`), then `vite build` emits the SPA
#                    into packages/web/dist.
#   5. runtime       distroless image: one binary on port 8080 plus the SPA under
#                    TRAME_STATIC_DIR. `/api` and `/ws` stay served by the same binary.
#
# The Rust tag must match `channel` in `rust-toolchain.toml`; the Node tag must
# match the `web-dev` service in `docker-compose.dev.yml`.

FROM rust:1.99.1-bookworm AS rust-source
# rust-toolchain.toml stays outside /build so rustup never auto-installs from it;
# the build fails instead when this image tag drifts from the pinned channel.
COPY rust-toolchain.toml /tmp/rust-toolchain.toml
RUN grep -qx "channel = \"$(rustc --version | cut -d' ' -f2)\"" /tmp/rust-toolchain.toml \
    && rustup target add wasm32-unknown-unknown
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates

FROM rust-source AS wasm-builder
ARG WASM_PACK_VERSION=0.15.1
ARG WASM_PACK_SHA256_X86_64=410101009739b9d01c7d5affaaad6e9c9a24b4cba6791a4805db8e89b9bf7af2
ARG WASM_PACK_SHA256_AARCH64=7004853c7925ae1984033b5f25866ec604bbc921ef956d5e6c5595bc5af6d30c
RUN arch="$(uname -m)" \
    && case "$arch" in \
         x86_64) sha="$WASM_PACK_SHA256_X86_64" ;; \
         aarch64) sha="$WASM_PACK_SHA256_AARCH64" ;; \
         *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
       esac \
    && name="wasm-pack-v${WASM_PACK_VERSION}-${arch}-unknown-linux-musl" \
    && curl -sSfLo "/tmp/${name}.tar.gz" "https://github.com/wasm-bindgen/wasm-pack/releases/download/v${WASM_PACK_VERSION}/${name}.tar.gz" \
    && echo "${sha}  /tmp/${name}.tar.gz" | sha256sum -c - \
    && tar -xzf "/tmp/${name}.tar.gz" --strip-components=1 -C /usr/local/cargo/bin "${name}/wasm-pack" \
    && rm "/tmp/${name}.tar.gz"
RUN wasm-pack build crates/trame-engine --release --target web --out-dir ../../packages/web/src/wasm

FROM rust-source AS rust-builder
RUN cargo build --release --locked --bin trame-server

FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS web-builder
WORKDIR /build/packages/web
COPY packages/web/package.json packages/web/package-lock.json ./
RUN npm ci
COPY packages/web ./
COPY packages/game-systems ../game-systems
COPY --from=wasm-builder /build/packages/web/src/wasm ./src/wasm
RUN npx tsc --noEmit -p tsconfig.build.json && npx vite build

FROM gcr.io/distroless/cc-debian12:nonroot
WORKDIR /app
COPY --from=rust-builder /build/target/release/trame-server /app/trame-server
COPY --from=web-builder /build/packages/web/dist /app/static
ENV TRAME_STATIC_DIR=/app/static
EXPOSE 8080
ENTRYPOINT ["/app/trame-server"]
