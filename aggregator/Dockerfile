# aggregator/Dockerfile — Multi-stage Rust build for the Aggregator Decision Engine
#
# Build context MUST be the monorepo root so that ../shared_protos/ is reachable.
#   docker-compose.yml sets:
#     build:
#       context: .
#       dockerfile: aggregator/Dockerfile
#
# ──────────────────────────────────────────────────────────────────────────────
# Stage 1: Builder
# ──────────────────────────────────────────────────────────────────────────────
FROM rust:1.80-slim-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake \
    pkg-config \
    libssl-dev \
    clang \
    libclang-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Dependency pre-cache layer ────────────────────────────────────────────────
COPY aggregator/Cargo.toml aggregator/Cargo.lock* aggregator/build.rs ./
COPY shared_protos/ ./shared_protos/

RUN mkdir -p src && echo 'fn main() {}' > src/main.rs \
    && sed -i 's|../../shared_protos|./shared_protos|g' build.rs

RUN cargo build --release --features kafka 2>&1 || true
RUN rm -rf src target/release/aggregator target/release/deps/aggregator*

# ── Real source build ─────────────────────────────────────────────────────────
COPY aggregator/src ./src

RUN cargo build --release --features kafka 2>&1

# ──────────────────────────────────────────────────────────────────────────────
# Stage 2: Runtime
# ──────────────────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/aggregator /usr/local/bin/aggregator

RUN useradd -r -s /bin/false app_user
USER app_user

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/aggregator"]
