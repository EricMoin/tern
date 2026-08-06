// shim.js — the JSON-prop protocol over the tern-wasm C ABI.
//
// Mirrors the napi binding (src/bindings/tern-node): createNode(type, props)
// builds a detached template; root.addChild(child) materializes it; setProp /
// appendSpan mutate it; renderToCells(width, height) returns the structured
// per-cell stream a canvas painter consumes. The props objects are exactly
// the ones the napi protocol accepts (style keys: fg/bg/border_style/bold/
// dim/italic/underline/blink/reversed/hidden/strikethrough; every other
// scalar key is a layout/content prop).
//
// Memory contract: every string crosses the ABI as (ptr, len) into a bump
// scratch region handed out by tern_alloc; tern_reset_alloc reclaims it after
// each call. The wasm linear memory can grow between calls (which detaches
// old ArrayBuffer views), so every read re-fetches `memory.buffer` first.

export async function loadTern(wasmUrl) {
  const { instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl));
  const e = instance.exports;
  const mem = () => e.memory;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // Write a UTF-8 string into wasm linear memory; returns { ptr, len }.
  function writeStr(str) {
    const bytes = enc.encode(str);
    const ptr = e.tern_alloc(bytes.length);
    if (!ptr) throw new Error("tern_alloc failed (out of scratch memory)");
    if (bytes.length) new Uint8Array(mem().buffer, ptr, bytes.length).set(bytes);
    return { ptr, len: bytes.length };
  }

  // The message of the last failed operation ("" when it succeeded).
  function lastError() {
    const len = e.tern_last_error(0, 0);
    if (!len) return "";
    const ptr = e.tern_alloc(len);
    e.tern_last_error(ptr, len);
    const msg = dec.decode(new Uint8Array(mem().buffer, ptr, len));
    e.tern_reset_alloc();
    return msg;
  }

  // A node handle: a detached template until addChild binds it to the scene.
  class Node {
    constructor(id) {
      this.id = id;
    }

    // Materialize a detached template under this node (chainable).
    addChild(child) {
      const bound = e.tern_add_child(this.id, child.id);
      if (!bound) throw new Error(lastError());
      child.id = bound;
      return child;
    }

    // Detach this node (and its subtree); the handle keeps its template so it
    // can be re-attached elsewhere.
    remove() {
      return !!e.tern_remove(this.id);
    }

    setProps(props) {
      const p = writeStr(JSON.stringify(props));
      if (!e.tern_set_props(this.id, p.ptr, p.len)) throw new Error(lastError());
      return this;
    }

    setProp(key, value) {
      const k = writeStr(key);
      const v = writeStr(JSON.stringify(value));
      if (!e.tern_set_prop(this.id, k.ptr, k.len, v.ptr, v.len)) throw new Error(lastError());
      return this;
    }

    appendSpan(text, style = {}) {
      const t = writeStr(text);
      const s = writeStr(JSON.stringify(style));
      if (!e.tern_append_span(this.id, t.ptr, t.len, s.ptr, s.len)) throw new Error(lastError());
      return this;
    }
  }

  return {
    // Reset the shared scene + compositor to a fresh state.
    reset() {
      e.tern_reset();
    },
    // The scene root handle (always 0).
    root() {
      return new Node(e.tern_root());
    },
    // createNode(type, props) — the JSON-prop protocol template factory.
    createNode(type, props = {}) {
      const t = writeStr(type);
      const p = writeStr(JSON.stringify(props));
      const id = e.tern_create_node(t.ptr, t.len, p.ptr, p.len);
      if (!id) throw new Error(lastError());
      return new Node(id);
    },
    // Render the scene and decode the flat per-cell stream.
    // Returns { width, height, count, cells: Uint32Array, blob: Uint8Array }.
    // Cell layout (TernWasmCell, 24 bytes, 6 × u32, cell i at i*6):
    //   ch  symbol_off  symbol_len  fg  bg  flags
    // Colors: tag 0 = default, 1 = indexed palette (low byte),
    //         2 = truecolor 0x02rrggbb.
    // Flags: bit0 bold, 1 dim, 2 italic, 3 underline, 4 reversed,
    //        5 blink, 6 hidden, 7 strikethrough, 8 masked (skip the cell).
    renderToCells(width, height) {
      const ptr = e.tern_render_to_cells(width, height);
      if (!ptr) throw new Error(lastError());
      const count = e.tern_cell_count();
      const blobLen = e.tern_cell_blob_len();
      // Fresh buffer view: the last export call may have grown the memory.
      const cells = new Uint32Array(mem().buffer, ptr, count * 6);
      const blob = blobLen
        ? new Uint8Array(mem().buffer, e.tern_cell_blob_ptr(), blobLen)
        : new Uint8Array(0);
      return { width, height, count, cells, blob };
    },
  };
}
