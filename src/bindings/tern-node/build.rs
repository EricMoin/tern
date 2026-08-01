//! napi-rs build glue: emits the linker flags Node-API addons need on macOS
//! (`-undefined dynamic_lookup`) and Windows (`delayimp`).

fn main() {
    napi_build::setup();
}
