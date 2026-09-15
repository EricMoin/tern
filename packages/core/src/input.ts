//! The single-line Input element and its edit model.

import { Node, Text } from "./node.ts";
import { clusterAt, columnToIndex, indexToColumn, lastClusterBefore } from "./textutil.ts";
import { textWidth } from "./textwrap.ts";
import type { NodeProps } from "./types.ts";

import type {
  ContentSize,
  HighlightSpanJs,
  KeyEvent,
  LifecycleEvent,
  MouseEventJs,
  NodeHandle as NativeNodeHandle,
  RendererCapabilities,
  SceneSemanticsJs,
  StyleRunJs,
  TernEventJs,
  TuiRenderer as NativeTuiRenderer,
  TuiRendererOptions,
} from "@tern-tui/node";
import { syncSemantics } from "./semantics.ts";
/** Props for the `Input` element. Style/layout keys flow to the framed box;
 * `value`/`caret`/`placeholder` drive the composed text leaf. */
export interface InputProps extends NodeProps {
  /** The input's current value (default `""`). */
  value?: string;
  /**
   * The caret's display column (default `0`). The compositor paints a block
   * caret at this column on the text leaf (compositor.rs:394-406).
   */
  caret?: number;
  /** Dimmed text shown when the value is empty. */
  placeholder?: string;
}

/** The text leaf props for an input state: the value (or the dimmed
 * placeholder when empty) plus the caret column. */
function inputTextProps(
  value: string,
  caret: number,
  placeholder: string | undefined,
): NodeProps {
  const empty = value === "";
  const textProps: NodeProps = {
    text: empty && placeholder !== undefined ? placeholder : value,
    caret,
  };
  if (empty && placeholder !== undefined) textProps.dim = true;
  return textProps;
}

/** Apply a new value/caret to an input node: syncs the node's own props (the
 * source of truth for `editKey`) and the composed text leaf (what the
 * compositor paints). */
function setInputState(input: Node, value: string, caret: number): void {
  const props = input.props;
  const placeholder = typeof props.placeholder === "string"
    ? props.placeholder
    : undefined;
  const leaf = input.children[0];
  if (leaf !== undefined && leaf.type === "text") {
    leaf.setProps(inputTextProps(value, caret, placeholder));
  }
  input.setProps({ ...props, value, caret });
}

/**
 * Create an `input` element: a framed box (the input's style/layout props)
 * with a `text` leaf child carrying the value as its `text` prop, the caret
 * as a `caret` Int prop (painted as a block caret), and a dim placeholder
 * when the value is empty. Edit it with {@link editKey}.
 */
export function Input(props: InputProps = {}): Node {
  const value = props.value ?? "";
  const caret = props.caret ?? 0;
  const leaf = Text(inputTextProps(value, caret, props.placeholder));
  const node = Node.create("input", props, [leaf]);
  syncSemantics(node);
  return node;
}

/**
 * Apply a key to an input node, mutating its value and caret in place.
 * Handles `char` insert, `backspace`, `left`/`right`, `home` and `end`;
 * any other key leaves the input unchanged. Because the caret is a display
 * column, movement and deletion are multi-width aware (a wide char counts
 * two columns) and grapheme aware: the cursor, backspace and right/left
 * arrows move whole grapheme clusters (a ZWJ emoji or a base-plus-combining
 * sequence is one step, never split mid-cluster), mirroring tern-core's
 * cluster-width convention (cell.rs:75). Returns the new `{ value, caret }`.
 */
export function editKey(
  input: Node,
  key: KeyEvent,
): { value: string; caret: number } {
  const props = input.props;
  const value = typeof props.value === "string" ? props.value : "";
  const caret = typeof props.caret === "number" ? props.caret : 0;
  const next = applyEditKey(value, caret, key);
  if (next.value !== value || next.caret !== caret) {
    setInputState(input, next.value, next.caret);
  }
  return next;
}

/** Pure edit-key computation shared by {@link editKey}. */
function applyEditKey(
  value: string,
  caret: number,
  key: KeyEvent,
): { value: string; caret: number } {
  const name = key.name;
  if (name === "char" && !key.ctrl && !key.alt && key.char !== undefined) {
    const index = columnToIndex(value, caret);
    const next = value.slice(0, index) + key.char + value.slice(index);
    // The caret lands on the cluster boundary after the inserted char — the
    // display column at the end of the inserted text (a combining mark or
    // ZWJ that merges into a cluster advances by that cluster's width).
    return { value: next, caret: indexToColumn(next, index + key.char.length) };
  }
  if (name === "backspace") {
    const prev = lastClusterBefore(value, columnToIndex(value, caret));
    if (prev === null) return { value, caret };
    const next = value.slice(0, prev.start) +
      value.slice(prev.start + prev.len);
    return { value: next, caret: Math.max(0, caret - prev.width) };
  }
  if (name === "left") {
    const prev = lastClusterBefore(value, columnToIndex(value, caret));
    if (prev === null) return { value, caret };
    return { value, caret: Math.max(0, caret - prev.width) };
  }
  if (name === "right") {
    const cluster = clusterAt(value, columnToIndex(value, caret));
    if (cluster === null) return { value, caret };
    return { value, caret: caret + cluster.width };
  }
  if (name === "home") return { value, caret: 0 };
  if (name === "end") {
    return { value, caret: indexToColumn(value, value.length) };
  }
  return { value, caret };
}

/**
 * Insert pasted text into an input node at the caret, mutating its value and
 * caret in place — the paste counterpart of {@link editKey}. The caret is a
 * display column, so the insertion is multi-width aware: the text lands at the
 * grapheme-cluster boundary snapped back from the caret column (a column
 * inside a wide cluster inserts before that cluster), and the caret advances
 * by the pasted text's total display width (its clusters' widths — a ZWJ
 * emoji counts 2, never per code point). Returns the new `{ value, caret }`.
 */
export function pasteInto(
  input: Node,
  text: string,
): { value: string; caret: number } {
  const props = input.props;
  const value = typeof props.value === "string" ? props.value : "";
  const caret = typeof props.caret === "number" ? props.caret : 0;
  const index = columnToIndex(value, caret);
  const next = value.slice(0, index) + text + value.slice(index);
  const nextCaret = caret + textWidth(text);
  setInputState(input, next, nextCaret);
  return { value: next, caret: nextCaret };
}

