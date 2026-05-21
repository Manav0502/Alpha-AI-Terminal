fn main() {
    println!("cargo:rerun-if-changed=../../shared_protos/predictive_data.proto");
    println!("cargo:rerun-if-changed=../../shared_protos/market_data.proto");

    // SAFETY: build scripts are single-threaded; no concurrent env reads.
    unsafe {
        std::env::set_var("PROTOC", protoc_bin_vendored::protoc_bin_path().unwrap());
    }

    prost_build::Config::new()
        .compile_protos(
            &["../../shared_protos/predictive_data.proto", "../../shared_protos/market_data.proto"],
            &["../../shared_protos"],
        )
        .unwrap();
}