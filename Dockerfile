# TRAME Production Multi-Stage Single Binary Image (Cloud Run / e2-micro)
FROM rust:1-bookworm AS rust-builder
WORKDIR /build
COPY Cargo.toml ./
COPY crates ./crates
RUN cargo build --release --bin trame-server

FROM gcr.io/distroless/cc-debian12:nonroot
WORKDIR /app
COPY --from=rust-builder /build/target/release/trame-server /app/trame-server
EXPOSE 8080
ENTRYPOINT ["/app/trame-server"]
