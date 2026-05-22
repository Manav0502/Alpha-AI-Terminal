// build.rs — Protobuf compilation pipeline for the ingestion service.
//
// This script runs automatically before `cargo build`. It uses `prost-build`
// to compile the `.proto` schemas in `../shared_protos/` into Rust structs
// that are included via `include!(concat!(env!("OUT_DIR"), "/...rs"))`.
//
// The compiled output is written to $OUT_DIR (managed by Cargo) and is NOT
// committed to version control (covered by .gitignore's proto-gen exclusion).
//
// No system protoc required: protoc-bin-vendored supplies a pre-compiled
// binary for Windows / Linux / macOS at build time.

fn main() {
    // ── Point prost-build at the vendored protoc binary ─────────────────────
    // This eliminates the requirement for `protoc` to be on PATH, making the
    // project buildable on a fresh Windows machine without extra tool installs.
    let protoc_path = protoc_bin_vendored::protoc_bin_path()
        .expect("protoc-bin-vendored could not locate the bundled protoc binary");

    std::env::set_var("PROTOC", protoc_path);

    // ── Compile the shared proto definitions ─────────────────────────────────
    // Only market_data.proto is needed for Phase 1.2.
    // Additional protos (sentiment_data, technical_data, decision) are added
    // in later phases when their respective agents are implemented.
    prost_build::compile_protos(
        &["../shared_protos/market_data.proto"],   // Source .proto files
        &["../shared_protos/"],                    // Include path (resolves imports)
    )
    .expect("Failed to compile protobuf definitions. Ensure shared_protos/ is accessible.");
}
