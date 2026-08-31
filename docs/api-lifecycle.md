# Public API lifecycle (M5.2)

The deprecation policy and feature-flag pattern that implement the
**boundary-change process** in [api-stability.md](api-stability.md): how public
surface is deprecated (deprecate → warn → remove), how experimental surface is
opted into and graduates to stable, and how real runtime behavior switches are
gated. The M5.1 audit ([api-stability.md](api-stability.md), 2026-08-27) is the
input: a **519-symbol freeze set** (stable), an **86-symbol experimental band**,
23 internal symbols, and 0 deprecation candidates — so this document is the
forward-looking contract that governs the first deprecation whenever the
boundary narrows.

The transition table in [api-stability.md](api-stability.md) §Boundary-change
process is the **trigger** for both mechanisms in this document: no symbol
enters the deprecation lifecycle, and no experimental symbol is promoted or
narrowed, except through a recorded boundary-change transition.

## 1. Deprecation policy

### 1.1 The lifecycle in one line

**deprecate → warn → remove**, with every step recorded in writing. A symbol is
annotated `@deprecated` in the release that begins the cycle (deprecate), emits
a warn-once notice to consumers while remaining fully functional (warn), and is
removed no earlier than **≥ 1 minor version cycle** after the release that first
shipped the deprecation (remove). Removal is never silent, and the migration
runway — the warn phase — is mandatory, not optional.

### 1.2 Entry: the boundary-change transition table is the trigger

A symbol becomes a deprecation candidate **only** through one of the two
transition rows in the [api-stability.md](api-stability.md) §Boundary-change
process table:

| Transition | Allowed when | Consequence |
|------------|--------------|-------------|
| **stable → deprecation-candidate** | A symbol is superseded or must be removed | M5.2 lifecycle only: deprecate → warn → remove across **≥ 1 minor release cycle**; replacement name recorded; never silent. |
| **experimental → deprecation-candidate** | The freeze narrows the experimental band | Same lifecycle as stable → candidate; the `@experimental` tag is superseded by `@deprecated`. |

Nothing else opens a deprecation. In particular, the M5.1 hand-off "watch
items" (the solid universal-renderer mount surface, the behavior-bearing solid
wiring helpers, the napi `IncrementalHighlighter` class) are **not** candidates
today — they are experimental surface that has not graduated to stable, and
M5.2 must not run a deprecation cycle on any of them without a new
boundary-change decision (per the M5.1 hand-off note). Internal symbols (23)
are excluded from the deprecation lifecycle entirely: they may be removed or
reorganized **without** notice or deprecation in any version — that is the
point of the internal tier.

### 1.3 The deprecation record — never silent

Every deprecation must record, **at deprecation time**:

1. the symbol — surface (`@tern-tui/core` / `@tern-tui/react` /
   `@tern-tui/solid` / napi backside) + name;
2. the symbol kind — function / value-object export / type;
3. the **named replacement** — the symbol consumers are directed to;
4. the **scheduled removal version** — the earliest release the symbol may be
   removed in (see §1.6);
5. the boundary-change transition that triggered it, and the date.

The record lands in three places: the `@deprecated` JSDoc on the symbol
(carrying the replacement and the scheduled removal version), the symbol's row
in the [api-stability.md](api-stability.md) inventory table (stability tag
flips to `deprecation-candidate`, replacement + removal version added to the
notes), and the CHANGELOG. A symbol without a recorded replacement and a
scheduled removal version is **not deprecated** — it is simply unmaintained,
which is a different, undocumented state and is not allowed for public surface.

```ts
/**
 * @deprecated Use `mergeTheme` instead. Scheduled for removal in 0.4.0.
 * @since 0.1.0
 */
```

### 1.4 Phase 1 — deprecate

The release that first ships the `@deprecated` marker. Nothing about the
symbol's behavior changes: it remains fully functional and
signature-identical, and it keeps working for the entire warn phase. The
deprecation act itself is **never** a breaking change — a deprecation that
breaks consumers is a bug, not a policy.

### 1.5 Phase 2 — warn (per-symbol-kind mechanisms)

The warn mechanism depends on the symbol kind, because the runtime surface each
kind exposes is different:

| Kind | Warn mechanism | Runtime hook |
|------|----------------|--------------|
| **functions** | wrap + **warn-once** shim | the call itself |
| **value / object exports** | **warn-once** Proxy on property access | the first `get` on the proxied object |
| **types** | JSDoc `@deprecated` only | none — type-level; surfaced by editors / `deno check` diagnostics |

**Functions — wrap + warn-once shim.** The deprecated export becomes a thin
wrapper that keeps the exact signature, forwards to the replacement, and warns
exactly once per process:

```ts
let warned = false;
/**
 * @deprecated Use `mergeTheme` instead. Scheduled for removal in 0.4.0.
 * @since 0.1.0
 */
export function mergeThemes(a: Theme, b: Theme): Theme {
  if (!warned) {
    warned = true;
    console.warn(
      "[tern] mergeThemes is deprecated; use mergeTheme instead (removal scheduled for 0.4.0).",
    );
  }
  return mergeTheme(a, b);
}
```

**Value / object exports — warn-once Proxy on property access.** An object or
instance export is wrapped in a `Proxy` whose `get` trap warns once on the
**first property access** and then forwards:

```ts
let warned = false;
/**
 * @deprecated Use `defaultTheme` instead. Scheduled for removal in 1.0.
 * @since 0.2.0
 */
export const legacyTheme: Theme = new Proxy(defaultTheme, {
  get(target, prop, receiver) {
    if (!warned) {
      warned = true;
      console.warn(
        "[tern] legacyTheme is deprecated; use defaultTheme instead (removal scheduled for 1.0).",
      );
    }
    return Reflect.get(target, prop, receiver);
  },
});
```

Warn on first **access**, not at import time — importing the module must not
warn unless the value is actually used. A scalar constant export (a `const`
string or number) cannot be proxied without changing the export shape, which
would itself be a contract change; scalar constants are therefore documented
via `@deprecated` JSDoc only, like types.

**Types — JSDoc `@deprecated` only.** Types have no runtime presence, so there
is nothing to hook and no runtime warning is possible or needed. The
`@deprecated` JSDoc carries the replacement and the scheduled removal version;
editors and `deno check` surface it as a diagnostic (strikethrough / info).
Consuming a deprecated type executes no code, so the type row is documentation
only — and still subject to the record rule of §1.3.

**Shared warn-once semantics:** at most one warning per process per symbol
(module-level flag); `[tern]` prefix; `console.warn`; never throws; never fires
in the hot path — a TUI frame loop that calls a deprecated helper must not
spam the terminal.

### 1.6 Phase 3 — remove (≥ 1 minor version cycle)

Removal is a breaking change and obeys the boundary contract:

- The **earliest** removal version is the scheduled removal version recorded at
  deprecation time, and that version must be **≥ 1 minor version cycle** after
  the release that first shipped the deprecation. Deprecated in 0.3.0 → the
  scheduled removal version cannot be earlier than 0.4.0.
- The scheduled version is a **floor**: a removal may be deferred, never pulled
  earlier.
- **Pre-1.0 (0.x):** removal of a deprecated frozen-at-1.0 symbol ships in a
  minor — the deprecation cycle is the permission. Per the boundary-change
  process, breaking changes to frozen-at-1.0 symbols still require the cycle
  pre-1.0; the cycle *is* what authorizes the break.
- **Post-1.0:** removing a symbol in the 519-symbol freeze set breaks the 1.0
  contract and requires a **major** version. The warn phase spans the ≥ 1
  minor cycle leading into it (deprecate 1.4 → warn 1.5 → remove 2.0).
- Removal = the export disappears (or drops to `internal` if tooling still
  needs the implementation) + a CHANGELOG "Removed" entry + the inventory row
  updated. Consumers who skip the cycle get no bridge — the ≥ 1 minor cycle of
  runtime warnings is the migration runway.

### 1.7 What never gets deprecated

The internal tier (23 symbols) is outside the lifecycle: removed or reorganized
without notice or deprecation. And the M5.1 watch items — tagged
`@experimental` today — are not deprecation candidates until a boundary-change
decision narrows them; running a deprecation on them early would be a policy
violation, not an act of caution.

## 2. Feature-flag pattern

Two different mechanisms both get called "feature flags" in tern. They are
deliberately distinct:

| Mechanism | What it gates | Flag mechanism |
|-----------|---------------|----------------|
| **API-surface opt-in** (§2.1) | Whether a symbol is part of the freeze promise | The tier tag itself (`@experimental` / `@since` JSDoc); opting in = importing |
| **Runtime behavior switch** (§2.3) | Whether a behavior actually runs | A real gate: default-off, capability/probe-gated (M4.2 precedent) |

### 2.1 API-surface opt-in: the tier tag is the flag

New exports enter the world as **experimental by default** — the
"new symbol" row of the boundary-change process transition table: any new
export enters as experimental (or internal for seams/tests), and it becomes
stable only through a release cycle. Every experimental symbol carries
`@experimental` + `@since` JSDoc:

```ts
/**
 * Runtime theme swap engine. Experimental: may change within 0.x; not part of
 * the 1.0 freeze contract.
 * @experimental
 * @since 0.3.0
 */
export function setTheme(theme: Theme): void { /* ... */ }
```

**Consumers opt in per-symbol by importing.** There is no runtime gate for
API-surface opt-in: no environment variable, no `enableExperimental()` call, no
flag object. The tier tag **is** the flag. Importing an experimental symbol is
the entire act of opting in.

Why no runtime gate for API-surface opt-in: the experimental contract is about
what tern promises, not about what the runtime does. An experimental symbol
runs identically whether or not the consumer knows it is experimental — the
flag is the documentation that tells the consumer which promise they are *not*
getting (may change or move within 0.x, may break in a minor). A runtime gate
would add machinery without changing that bargain, and it would tempt import
side effects (see §2.3's boundary rule).

`@since` grounds the graduation check: it records the first version (or
milestone commit) the symbol shipped, so "has this symbol survived a release
cycle?" has a mechanical answer. A symbol tagged `@since 0.2.0` shipped in the
0.2.0 release.

The current band: **86 experimental symbols** across the four surfaces (core
28, react 28, solid 25, napi 5) — the M3/M4-era surface that has not survived a
release cycle, held out of the **519-symbol freeze set** on purpose
([api-stability.md](api-stability.md) §Stays experimental).

### 2.2 Graduation: experimental → stable

Promotion is the reward for a proven contract:

- **Requires ≥ 1 release cycle (minor or patch) with no contract change.** The
  symbol must have shipped in a release and survived it — `@since` proves the
  release; the unchanged contract proves the cycle.
- Promotion **cannot happen in the same minor cycle that introduced the
  symbol** — an unreleased symbol has nothing to graduate from.
- Procedure (the "experimental → stable" row of the boundary-change process):
  promotion decision + CHANGELOG note + inventory table updated + the
  `@experimental` tag dropped (the `@since` tag stays — it is the provenance
  record).
- If a contract change is needed during the cycle, the symbol **stays**
  experimental and the change is allowed — that is the experimental bargain —
  and the cycle restarts from the changed contract.
- If the freeze narrows instead, the symbol does not graduate: it enters the
  deprecation lifecycle via **experimental → deprecation-candidate** (§1.2).
- M5.7 (the 1.0 release) re-verifies the 13-symbol contested band
  (selection/stream-follow helpers, `setTheme`/`getTheme`) before declaring the
  freeze, per the M5.7 checklist in the boundary-change process.

### 2.3 Runtime behavior switches: the M4.2 precedent

When a feature needs to change **runtime behavior** — not API surface — follow
the M4.2 a11y precedent documented in [a11y.md](a11y.md): **default-off,
capability/probe-gated**, additive to painted output. The a11y examples:

- The semantics store is **off by default**; a renderer constructed with
  `semantics: true` opts in, and `Node.setSemantics` writes are rejected
  natively while off ([a11y.md](a11y.md) "The default-off contract").
- The iTerm2 OSC 1337 `AddHiddenAnnotation` emitter is gated on **probe
  identity** — it emits only when the terminal probe's `terminalIdentity`
  reports iTerm2 — default off, and unit-tested only ([a11y.md](a11y.md) "The
  iTerm2 reality check").
- The generic JSONL semantics stream is opt-in (`startA11yStream`) and never
  changes painted frames — paint-invariance is a tested property.

Distilled rules for any new runtime switch:

1. **Defaults off.** The current behavior of an existing consumer is never
   changed by a new switch.
2. **Enabling is explicit and per-instance** where the behavior is
   per-renderer: a constructor option or an explicit enable call — never an
   import side effect.
3. **Vendor-specific emission is additionally gated on a capability/probe
   check.** No escape sequence is ever written to a terminal that does not
   support it (the iTerm2 emitter's probe gate).
4. **The switch is additive:** default painted output is byte-identical with
   the switch on or off.
5. **Probe-gated features are unit-tested only** — no CI job runs a real
   terminal against them.

**The boundary rule:** an API-surface opt-in (an import) must never change the
runtime behavior of anything else — importing experimental surface is not a
runtime gate, and importing it must not emit sequences or flip behavior. If a
feature needs a real runtime gate, it ships as a §2.3 switch on the surface it
gates (e.g. the renderer options), never smuggled in as an import side effect.

### 2.4 The flag record

- API-surface flags live in the [api-stability.md](api-stability.md) inventory
  (the stability column, tagged per symbol) plus the `@experimental`/`@since`
  JSDoc on the symbol.
- Runtime switches live in the constructor/option documentation of the surface
  they gate — the semantics/a11y options documented in [a11y.md](a11y.md) are
  the model.
- Every flag introduction, promotion, or narrowing gets a CHANGELOG note, and
  every tier change updates the inventory table and the boundary-change process
  — per the "the freeze boundary is a living record" rule in
  [api-stability.md](api-stability.md) §Boundary-change process.
- A runtime switch that is later replaced is deprecated like any other API —
  functions wrap + warn-once shim, options go through the value-object row of
  §1.5 — so the two halves of this document compose.
