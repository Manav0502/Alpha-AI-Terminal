// build.rs — Protobuf compilation pipeline for the aggregator.
//
// This script runs automatically before `cargo build`. It uses `prost-build`
// to compile the `.proto` schemas in `../shared_protos/` into Rust structs
// that are included via `include!(concat!(env!("OUT_DIR"), "/...rs"))`.
//
// Compiled output is written to $OUT_DIR (managed by Cargo) and is NOT
// committed to version control.
//
// No system protoc required: protoc-bin-vendored supplies a pre-compiled
// binary for Windows / Linux / macOS at build time.

fn main() {
    // ── Point prost-build at the vendored protoc binary ─────────────────────
    // Eliminates the requirement for `protoc` to be on PATH, making the
    // project buildable on a fresh Windows machine without extra tool installs.
    let protoc_path = protoc_bin_vendored::protoc_bin_path()
        .expect("protoc-bin-vendored: could not locate the bundled protoc binary");

    std::env::set_var("PROTOC", protoc_path);

    // ── Compile the shared proto definitions ─────────────────────────────────
    // technical_data.proto  → provides the `TechSignal` struct consumed from Kafka.
    // sentiment_data.proto  → provides the `NewsSentiment` struct consumed from Kafka.
    // decision.proto        → provides the `AggregatedDecision` struct we will produce.
    prost_build::compile_protos(
        &[
            "../shared_protos/technical_data.proto",  // TechSignal — inbound from Kafka
            "../shared_protos/sentiment_data.proto",  // NewsSentiment — inbound from Kafka
            "../shared_protos/decision.proto",        // AggregatedDecision — outbound to Kafka
            "../shared_protos/market_data.proto",     // Tick — inbound for OHLC aggregation
        ],
        &["../shared_protos/"], // include path (resolves proto imports)
    )
    .expect("Failed to compile protobuf definitions. Ensure shared_protos/ is accessible from aggregator/.");
}
