// painter.js — a canvas painter for the tern-wasm cell stream.
//
// Consumes the flat per-cell payload from shim.js renderToCells(): each cell
// carries the cluster symbol/lead char, fg/bg colors (tag-encoded) and
// text-modifier flags. Masked continuation cells (the zero-width right halves
// of wide glyphs) are skipped — their lead cell drew the whole glyph.

const FLAG = {
  BOLD: 1 << 0,
  DIM: 1 << 1,
  ITALIC: 1 << 2,
  UNDERLINE: 1 << 3,
  REVERSED: 1 << 4,
  MASKED: 1 << 8,
};

// The xterm 256-color palette: 16 base colors, the 6×6×6 color cube, and the
// grayscale ramp. Approximates tern's Color::Indexed(n) for the demo; RGB
// cells paint exactly.
const CUBE_STEPS = [0, 95, 135, 175, 215, 255];
const BASE16 = [
  "#000000", "#800000", "#008000", "#808000", "#000080", "#800080",
  "#008080", "#c0c0c0", "#808080", "#ff0000", "#00ff00", "#ffff00",
  "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
];

function indexedColor(n) {
  if (n < 16) return BASE16[n];
  if (n < 232) {
    const i = n - 16;
    const r = CUBE_STEPS[(i / 36) | 0];
    const g = CUBE_STEPS[((i / 6) | 0) % 6];
    const b = CUBE_STEPS[i % 6];
    return `rgb(${r},${g},${b})`;
  }
  const v = 8 + (n - 232) * 10;
  return `rgb(${v},${v},${v})`;
}

// Decode a tag-encoded ABI color: 0 = default, 1 = indexed, 2 = truecolor.
function decodeColor(enc, fallback) {
  const tag = enc >>> 24;
  if (tag === 2) return `rgb(${(enc >> 16) & 255},${(enc >> 8) & 255},${enc & 255})`;
  if (tag === 1) return indexedColor(enc & 255);
  return fallback;
}

export class TernCanvasPainter {
  // `fallbacks` picks the default fg/bg when a cell carries Color::Default.
  constructor(canvas, { cellW = 11, cellH = 20, font = "11px monospace" } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.cellW = cellW;
    this.cellH = cellH;
    this.font = font;
    this.fallbacks = { fg: "#d7d7d7", bg: "#151515" };
    this._lastSize = { w: 0, h: 0 };
  }

  // Paint a frame from shim.renderToCells(). Returns the rendered size.
  paint(frame) {
    const { width, height, cells, blob } = frame;
    const ctx = this.ctx;
    if (this._lastSize.w !== width || this._lastSize.h !== height) {
      this.canvas.width = width * this.cellW;
      this.canvas.height = height * this.cellH;
      this._lastSize = { w: width, h: height };
    }

    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = this.fallbacks.bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const { cellW, cellH } = this;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 6;
        const ch = cells[i];
        const symOff = cells[i + 1];
        const symLen = cells[i + 2];
        const fg = cells[i + 3];
        const bg = cells[i + 4];
        const flags = cells[i + 5];
        if (flags & FLAG.MASKED) continue; // wide glyph's right half

        // The cluster's display text: the symbol blob wins over the lead char.
        let text;
        if (symLen) {
          text = new TextDecoder().decode(blob.subarray(symOff, symOff + symLen));
        } else if (ch) {
          text = String.fromCodePoint(ch);
        } else {
          text = " ";
        }

        const px = x * cellW;
        const py = y * cellH;
        // Reversed swaps the effective fg/bg (block-caret/selection style).
        const rev = flags & FLAG.REVERSED;
        const fgC = decodeColor(rev ? bg : fg, rev ? this.fallbacks.bg : this.fallbacks.fg);
        const bgC = decodeColor(rev ? fg : bg, rev ? this.fallbacks.fg : this.fallbacks.bg);

        ctx.fillStyle = bgC;
        ctx.fillRect(px, py, cellW, cellH);

        ctx.save();
        if (flags & FLAG.DIM) ctx.globalAlpha = 0.55;
        ctx.fillStyle = fgC;
        ctx.font = `${flags & FLAG.BOLD ? "bold " : ""}${flags & FLAG.ITALIC ? "italic " : ""}${this.font}`;
        ctx.textBaseline = "top";
        // A wide glyph spans 2 cells; center it over both columns.
        const wide = x + 1 < width && (cells[(y * width + x + 1) * 6 + 5] & FLAG.MASKED);
        const cx = px + (wide ? cellW : cellW / 2);
        ctx.fillText(text, cx - ctx.measureText(text).width / 2, py + 2);
        if (flags & FLAG.UNDERLINE) {
          ctx.strokeStyle = fgC;
          ctx.beginPath();
          ctx.moveTo(px + 1, py + cellH - 3);
          ctx.lineTo(px + cellW - 2, py + cellH - 3);
          ctx.stroke();
        }
        if (flags & FLAG.STRIKETHROUGH) {
          ctx.strokeStyle = fgC;
          ctx.beginPath();
          ctx.moveTo(px + 1, py + cellH / 2);
          ctx.lineTo(px + cellW - 2, py + cellH / 2);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
    return { width, height };
  }
}
