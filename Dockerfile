# TRAME Production Multi-Stage Single Binary Image (Cloud Run / e2-micro)
FROM rust:1-bookworm AS rust-builder
WORKDIR /build
COPY Cargo.toml ./
COPY crates ./crates
RUN cargo build --release --bin trame-server

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
WORKDIR /app
COPY --from=rust-builder /build/target/release/trame-server /app/trame-server
EXPOSE 8080
ENTRYPOINT ["/app/trame-server"]
