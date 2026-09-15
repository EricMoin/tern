//! The Spinner element.

import { Node } from "./node.ts";
import type { NodeProps } from "./types.ts";
/** Props for the `Spinner` element. `value`+`max` (+`width`) select the
 * determinate bar; `frames`+`frame` select the indeterminate glyph. */
export interface SpinnerProps extends NodeProps {
  /** Determinate mode: the current progress value. */
  value?: number;
  /** Determinate mode: the maximum value. */
  max?: number;
  /** Determinate mode: the bar width in cells (default 10). */
  width?: number;
  /** Indeterminate mode: the frame glyphs to cycle through. */
  frames?: string[];
  /** Indeterminate mode: the current frame index (default 0). */
  frame?: number;
}

/** The default indeterminate frame glyphs (braille spinner). */
export const DEFAULT_SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

/** The text a spinner renders for the given props: the determinate
 * `'▓'`/`'░'` bar (exactly `ceil(value/max * width)` filled cells) or the
 * frame glyph at `frame` (wrapping). */
function spinnerText(props: SpinnerProps): string {
  const { value, max } = props;
  if (typeof value === "number" && typeof max === "number" && max > 0) {
    const width = typeof props.width === "number"
      ? Math.max(0, props.width)
      : 10;
    const filled = Math.max(
      0,
      Math.min(width, Math.ceil((value / max) * width)),
    );
    return "▓".repeat(filled) + "░".repeat(width - filled);
  }
  const frames = props.frames ?? DEFAULT_SPINNER_FRAMES;
  if (frames.length === 0) return "";
  const frame = typeof props.frame === "number" ? props.frame : 0;
  return frames[((frame % frames.length) + frames.length) % frames.length] ??
    "";
}

/**
 * Create a `spinner` element: a `text` leaf rendering a determinate
 * `'▓'`/`'░'` progress bar (from `value`/`max`/`width`) or an indeterminate
 * frame glyph (from `frames`/`frame`). Advance it with {@link tick}.
 */
export function Spinner(props: SpinnerProps = {}): Node {
  return Node.create("spinner", { ...props, text: spinnerText(props) }, []);
}

/**
 * Advance an indeterminate spinner's frame by one (wrapping around the frame
 * list) and repaint it via `setProps`. For a determinate spinner this
 * re-derives the bar from the current props and is a no-op when the bar is
 * unchanged. Returns the spinner's new text.
 */
export function tick(spinner: Node): string {
  const props = spinner.props as SpinnerProps;
  const current = typeof props.frame === "number" ? props.frame : 0;
  const determinate = typeof props.value === "number" &&
    typeof props.max === "number";
  const frame = determinate ? current : current + 1;
  const text = spinnerText({ ...props, frame });
  if (text !== props.text) spinner.setProps({ ...props, frame, text });
  return text;
}

