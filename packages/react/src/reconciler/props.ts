//! The per-element prop allowlists the host config routes by.

/** React-only props that must never reach a tern scene node. */
export const REACT_RESERVED_PROPS = new Set(["children", "key", "ref"]);

/**
 * Semantic theme hints consumed by the host components at render time (via
 * `resolveTheme`). They are never scene props — this strip guarantees a
 * `role` / `component` prop cannot leak onto a node even if a host component
 * forgets to resolve (constitution: theme output is plain node props).
 */
export const THEME_PROPS = new Set(["role", "component"]);

/**
 * Component-consumed props of `<StreamingText>` that must never reach a scene
 * node: `stream` is a non-scalar async iterable (the binding drops objects)
 * and `autoScroll` is a component behavior flag. `wrap` IS a scene prop — the
 * compositor honors `wrap: false` (single-row paint, trimmed at the right
 * edge), so it flows through to the core factory.
 */
export const STREAMING_TEXT_PROPS = new Set(["stream", "autoScroll"]);

/**
 * Component-consumed props of `<Input>` that must never reach a scene node:
 * `onChange` / `onSubmit` are callbacks, `focusId` is focus bookkeeping, and
 * `focusManager` is a non-scalar object (the binding drops objects). The
 * value/caret/placeholder state props flow through to the core factory.
 */
export const INPUT_PROPS = new Set(["onChange", "onSubmit", "focusId", "focusManager"]);

/** Component-consumed props of `<Textarea>` that must never reach a scene
 * node: the callbacks and the focus wiring (mirroring `<Input>`). The
 * lines/row/col/width/height/scroll edit-model props flow through to the
 * core factory. */
export const TEXTAREA_PROPS = new Set(["onChange", "onSubmit", "focusId", "focusManager"]);

/** Component-consumed props of `<Spinner>`: `interval` drives the timer, it
 * is not a scene prop. */
export const SPINNER_PROPS = new Set(["interval"]);

/**
 * Component-consumed props of `<Select>` that must never reach a scene node:
 * the callbacks and the focus wiring. The `options` list and the
 * `floating`/`multi`/state props flow through to the core factory, which
 * consumes the bookkeeping keys itself (the option list is JS bookkeeping,
 * `floating` maps to the root box's `z_index`).
 */
export const SELECT_PROPS = new Set(["onChange", "onConfirm", "onDismiss", "focusId", "focusManager"]);

/**
 * Component-consumed props of `<Menu>` that must never reach a scene node:
 * the callbacks and the focus wiring (mirroring `<Select>`). The `items`
 * model and the `floating`/`submenu`/state props flow through to the core
 * factory, which consumes the bookkeeping keys itself (the item model is JS
 * bookkeeping, `floating` maps to the root box's `z_index`).
 */
export const MENU_PROPS = new Set(["onSelect", "onDismiss", "focusId", "focusManager"]);

/**
 * Component-consumed props of `<Modal>` that must never reach a scene node:
 * `content` is the core `Node[]` modal body (JS bookkeeping the core factory
 * consumes, mirroring `<Panels>`' `panels`). The open/backdrop/z_index state
 * props flow through to the core factory.
 */
export const MODAL_PROPS = new Set(["content"]);

/**
 * Component-consumed props of `<Tabs>` that must never reach a scene node:
 * the callbacks and the focus wiring. The `tabs` spec list and the
 * active/closable state props flow through to the core factory, which
 * consumes the bookkeeping keys itself (the spec list is JS bookkeeping,
 * `closable` maps to the per-tab close affordance).
 */
export const TABS_PROPS = new Set(["onChange", "onClose", "focusId", "focusManager"]);

/**
 * Component-consumed props of `<Tree>` that must never reach a scene node:
 * the callback and the focus wiring (mirroring `<Tabs>`). The `nodes` model
 * and the `expanded` / `indent` bookkeeping flow through to the core
 * factory, which consumes them itself (they never reach the scene props).
 */
export const TREE_PROPS = new Set(["onChange", "focusId", "focusManager"]);

/** The string key the host components attach the runtime theme hint under
 * (never a scene prop — stripped by `toNodeProps` exactly like `role` /
 * `component`). */
export const THEME_HINT_CARRIER = "__ternThemeHint";

