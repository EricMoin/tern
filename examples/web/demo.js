// demo.js — builds the demo scene through the JSON-prop protocol (the same
// props the napi binding accepts) and animates a styled streaming line.
//
// The scene mirrors the Rust tern-demo (examples/rust/tern-demo): a column
// box with a rounded border and padding, holding title/subtitle text, plus a
// streaming_text node fed per-span styled text and a row of bg-colored boxes.

// Build the scene under `root` and return a handle to the streaming node.
export function buildDemo(tern, root) {
  // Window: column box, rounded border, 1-cell border + padding + gap.
  const windowBox = tern.createNode("box", {
    flex_direction: "column",
    border_style: "rounded",
    border: 1,
    padding: 1,
    gap: 1,
  });
  root.addChild(windowBox);

  const title = tern.createNode("text", {
    text: "tern wasm preview",
    bold: true,
  });
  windowBox.addChild(title);

  const subtitle = tern.createNode("text", {
    text: "Phase 6 spike — core crates compiled to wasm32-unknown-unknown",
    dim: true,
  });
  windowBox.addChild(subtitle);

  // The animated line: styled spans appended in order by startTyping.
  const stream = tern.createNode("streaming_text", { wrap: true });
  windowBox.addChild(stream);

  // A row of bg-colored boxes proving background + indexed colors paint.
  const colorRow = tern.createNode("box", { gap: 1, height: 3 });
  windowBox.addChild(colorRow);
  for (const [label, bg, fg] of [
    ["red", "#8b1a1a", "#ffffff"],
    ["green", "#1a5c1a", "#ffffff"],
    ["blue", "#1a1a8b", "#ffffff"],
    ["cyan", "indexed:37", "#000000"],
  ]) {
    const cell = tern.createNode("box", {
      width: 10,
      height: 3,
      bg,
      justify_content: "center",
      align_items: "center",
    });
    colorRow.addChild(cell);
    const labelNode = tern.createNode("text", { text: label, fg });
    cell.addChild(labelNode);
  }

  return stream;
}

// Type the demo line into the streaming node, one styled span at a time.
// Every span is appended through the JSON-prop protocol and the frame is
// re-rendered by the caller.
export function startTyping(stream, onFrame) {
  // [text, style] pairs; the wide chars exercise the masked-cell path.
  const script = [
    ["rendering ", {}],
    ["tern ", { fg: "#ff8800" }],
    ["scenes ", { bold: true }],
    ["in the ", { italic: true }],
    ["browser ", { fg: "#00d7d7" }],
    ["via a ", { underline: true }],
    ["plain ", { fg: "#ff55ff" }],
    ["C ABI — ", { bold: true, fg: "#ffffff" }],
    ["the same compositor ", {}],
    ["the terminal uses.", { dim: true }],
    [" wide: ", {}],
    ["コ", { fg: "#ff0000" }],
    [" + ", {}],
    ["👨‍👩‍👧‍👦", { fg: "#ffff00" }],
  ];

  let i = 0;
  const tick = () => {
    if (i >= script.length) {
      setTimeout(tick, 2500); // pause, then replay
      i = 0;
      return;
    }
    const [text, style] = script[i++];
    stream.appendSpan(text, style);
    onFrame();
    setTimeout(tick, 160);
  };
  setTimeout(tick, 400);
}
