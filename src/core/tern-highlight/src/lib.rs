//! tern-highlight — tree-sitter token highlighting mapped to styled spans.
//!
//! A small, standalone crate (roadmap Phase 4) that parses source with
//! tree-sitter and maps the grammar's highlight captures to tern [`Span`]s —
//! styled text chunks the compositor paints directly. It deliberately sits
//! outside the core render path (`tern-core` / `tern-layout` /
//! `tern-components` do not depend on it); the napi binding pulls it in to
//! feed [`MarkdownView`](https://docs.rs/tern/latest) code fences and
//! `StreamingText` streams.
//!
//! ## Approach
//!
//! Each grammar crate (tree-sitter-rust, tree-sitter-typescript,
//! tree-sitter-json, tree-sitter-bash, plus the M3.7 expansion:
//! tree-sitter-python, tree-sitter-go, tree-sitter-toml-ng,
//! tree-sitter-yaml, tree-sitter-c, tree-sitter-cpp) bundles its own
//! `HIGHLIGHTS_QUERY` (bash, C and C++ name it `HIGHLIGHT_QUERY`) and exposes
//! its language as a `LanguageFn` (`LANGUAGE` / `LANGUAGE_TYPESCRIPT` /
//! `LANGUAGE_TSX`), which converts into the tree-sitter runtime `Language`
//! via `From`. Parsing runs
//! once over the whole source — tree-sitter is error-tolerant, so half-open
//! streaming input still yields tokens. Capture names (e.g. `@keyword`,
//! `@string`, `@comment`, `@function.macro`) map onto a small One-Dark
//! palette that matches the `@tern/core` markdown constants.
//!
//! [`highlight`] returns a *complete* span stream: every byte of the source
//! is covered (unstyled gaps become default-style spans) and adjacent spans
//! with equal style merge, so the concatenated span texts reconstruct the
//! source exactly. Overlapping captures (e.g. `@comment.todo` inside
//! `@comment`) resolve to the most specific — smallest — covering capture.
//!
//! [`IncrementalHighlighter`] (Phase 9) is the streaming variant: it buffers
//! the source, keeps the previous parse tree, and re-parses only the tail on
//! each [`append`](IncrementalHighlighter::append). The grammar's highlight
//! queries are compiled once in
//! [`new`](IncrementalHighlighter::new) and reused for every append, and
//! [`last_changed_span`](IncrementalHighlighter::last_changed_span) reports
//! the byte span the last incremental parse actually reworked (the
//! "instrumented node count" proxy).


use tree_sitter::{
    InputEdit, Language as TsLanguage, Node, Parser, Point, Query, QueryCursor,
    StreamingIterator, Tree,
};
use tree_sitter_language::LanguageFn;
use tern_core::scene::Span;
use tern_core::style::{Modifiers, Style};

// The implementation stays in this file; the test module moved to
// src/tests.rs so both land under the line cap.

/// The languages this crate can highlight, with the grammar crate that backs
/// each one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Language {
    /// The Rust grammar (`tree-sitter-rust`).
    Rust,
    /// The TypeScript grammar (`tree-sitter-typescript`, non-JSX).
    TypeScript,
    /// The TSX grammar (JSX-flavored TypeScript, same crate).
    Tsx,
    /// The JavaScript grammar (`tree-sitter-javascript`). TypeScript trees
    /// also apply this grammar's highlight query — the TS grammar is a
    /// superset of the JS node types, and the JS query carries the string /
    /// number / comment / function captures the TS query delegates to
    /// injection.
    JavaScript,
    /// The JSON grammar (`tree-sitter-json`).
    Json,
    /// The Bash / POSIX shell grammar (`tree-sitter-bash`).
    Shell,
    /// The Python grammar (`tree-sitter-python`).
    Python,
    /// The Go grammar (`tree-sitter-go`).
    Go,
    /// The TOML grammar (`tree-sitter-toml-ng` — the maintained
    /// tree-sitter-grammars fork; the plain `tree-sitter-toml` crate is
    /// abandoned on an old binding and unused).
    Toml,
    /// The YAML grammar (`tree-sitter-yaml`).
    Yaml,
    /// The C grammar (`tree-sitter-c`).
    C,
    /// The C++ grammar (`tree-sitter-cpp`).
    Cpp,
}

impl Language {
    /// Resolve a Markdown fence info string (the token after the backticks,
    /// lowercased) to a language. Returns `None` for unknown names.
    pub fn from_fence_name(name: &str) -> Option<Self> {
        Some(match name.to_ascii_lowercase().as_str() {
            "rust" | "rs" => Self::Rust,
            "typescript" | "ts" => Self::TypeScript,
            "tsx" => Self::Tsx,
            "javascript" | "js" | "jsx" => Self::JavaScript,
            "json" => Self::Json,
            "bash" | "shell" | "sh" | "zsh" => Self::Shell,
            "python" | "py" => Self::Python,
            "go" | "golang" => Self::Go,
            "toml" => Self::Toml,
            "yaml" | "yml" => Self::Yaml,
            "c" => Self::C,
            "cpp" | "c++" | "cxx" => Self::Cpp,
            _ => return None,
        })
    }

    /// The grammar crate's language function for this language.
    fn grammar(self) -> LanguageFn {
        match self {
            Self::Rust => tree_sitter_rust::LANGUAGE,
            Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT,
            Self::Tsx => tree_sitter_typescript::LANGUAGE_TSX,
            Self::JavaScript => tree_sitter_javascript::LANGUAGE,
            Self::Json => tree_sitter_json::LANGUAGE,
            Self::Shell => tree_sitter_bash::LANGUAGE,
            Self::Python => tree_sitter_python::LANGUAGE,
            Self::Go => tree_sitter_go::LANGUAGE,
            Self::Toml => tree_sitter_toml_ng::LANGUAGE,
            Self::Yaml => tree_sitter_yaml::LANGUAGE,
            Self::C => tree_sitter_c::LANGUAGE,
            Self::Cpp => tree_sitter_cpp::LANGUAGE,
        }
    }

    /// The grammar's bundled highlight queries, in application order.
    ///
    /// TypeScript / TSX run the JavaScript query first and the TypeScript
    /// query second, so the more specific TypeScript captures win on tie;
    /// C++ does the same with the C query first and the C++ query second
    /// (the C++ grammar is a superset of C, and its bundled query only
    /// carries the C++-specific captures). Bash, C and C++ name their const
    /// `HIGHLIGHT_QUERY`; the other grammars use `HIGHLIGHTS_QUERY`.
    fn highlights_queries(self) -> &'static [&'static str] {
        match self {
            Self::Rust => &[tree_sitter_rust::HIGHLIGHTS_QUERY],
            Self::TypeScript | Self::Tsx => &[
                tree_sitter_javascript::HIGHLIGHT_QUERY,
                tree_sitter_typescript::HIGHLIGHTS_QUERY,
            ],
            Self::JavaScript => &[tree_sitter_javascript::HIGHLIGHT_QUERY],
            Self::Json => &[tree_sitter_json::HIGHLIGHTS_QUERY],
            Self::Shell => &[tree_sitter_bash::HIGHLIGHT_QUERY],
            Self::Python => &[tree_sitter_python::HIGHLIGHTS_QUERY],
            Self::Go => &[tree_sitter_go::HIGHLIGHTS_QUERY],
            Self::Toml => &[tree_sitter_toml_ng::HIGHLIGHTS_QUERY],
            Self::Yaml => &[tree_sitter_yaml::HIGHLIGHTS_QUERY],
            Self::C => &[tree_sitter_c::HIGHLIGHT_QUERY],
            Self::Cpp => &[
                tree_sitter_c::HIGHLIGHT_QUERY,
                tree_sitter_cpp::HIGHLIGHT_QUERY,
            ],
        }
    }
}

// One-Dark palette (matching the `@tern/core` markdown constants:
// `MARKDOWN_CODE_FG` is the keyword red and the fence bg the panel color).
const KEYWORD_FG: (u8, u8, u8) = (198, 120, 221); // #c678dd — keywords
const STRING_FG: (u8, u8, u8) = (152, 195, 121); // #98c379 — strings / escapes
const COMMENT_FG: (u8, u8, u8) = (127, 132, 142); // #7f848e — comments (italic)
const NUMBER_FG: (u8, u8, u8) = (209, 154, 102); // #d19a66 — numbers / constants
const FUNCTION_FG: (u8, u8, u8) = (97, 175, 239); // #61afef — functions
const TYPE_FG: (u8, u8, u8) = (229, 192, 123); // #e5c07b — types / constructors
const VARIABLE_FG: (u8, u8, u8) = (224, 108, 117); // #e06c75 — variables / fields
const BUILTIN_FG: (u8, u8, u8) = (86, 182, 194); // #56b6c2 — operators / attributes

/// A foreground color as a tern [`Style`].
fn fg(hex: (u8, u8, u8)) -> Style {
    Style::new().fg(tern_core::Color::Rgb(hex.0, hex.1, hex.2))
}

/// Map a tree-sitter capture name (e.g. `"keyword"`, `"function.macro"`,
/// `"punctuation.bracket"`) to a tern style. Full names are matched first;
/// unknown dotted names fall back to their base name before the first dot, so
/// grammar-specific variants (`comment.documentation`, `string.special.key`,
/// `type.builtin`) inherit the family style. Punctuation and unknown captures
/// map to the default style.
fn style_for_capture(name: &str) -> Style {
    let style = match name {
        // Comment family — italic grey.
        "comment" | "comment.documentation" => fg(COMMENT_FG).add_modifier(Modifiers::ITALIC),
        // String family.
        "string" | "string.special.key" | "escape" | "embedded" => fg(STRING_FG),
        // Number / constant family (rust integer/float/boolean literals land
        // here as `@constant.builtin`).
        "number" | "constant" | "constant.builtin" => fg(NUMBER_FG),
        // Function family.
        "function" | "function.call" | "function.method" | "function.macro" => fg(FUNCTION_FG),
        // Type family.
        "type" | "type.builtin" | "constructor" => fg(TYPE_FG),
        // Variable / field family.
        "property" | "variable.builtin" | "variable.parameter" | "label" | "attribute" => {
            fg(VARIABLE_FG)
        }
        "keyword" => fg(KEYWORD_FG),
        "operator" => fg(BUILTIN_FG),
        // Punctuation and anything else: no style.
        _ => {
            let base = name.split('.').next().unwrap_or(name);
            match base {
                "keyword" => fg(KEYWORD_FG),
                "string" => fg(STRING_FG),
                "comment" => fg(COMMENT_FG).add_modifier(Modifiers::ITALIC),
                "function" => fg(FUNCTION_FG),
                "type" => fg(TYPE_FG),
                "number" | "constant" => fg(NUMBER_FG),
                "operator" => fg(BUILTIN_FG),
                "variable" | "property" | "field" => fg(VARIABLE_FG),
                "constructor" => fg(TYPE_FG),
                "escape" | "embedded" => fg(STRING_FG),
                _ => Style::new(),
            }
        }
    };
    style
}

/// A raw tree-sitter capture: a byte range plus its mapped style.
type Capture = (usize, usize, Style);

/// Token-highlight `source` in `language` and return a complete span stream.
///
/// The returned spans cover every byte of the source (gaps between captures
/// get the default style) and merge adjacent same-style spans, so
/// `spans.concat_text() == source`. Empty or unparseable input yields an
/// empty stream. This is the entry point both the napi binding and the
/// golden buffer tests use.
pub fn highlight(language: Language, source: &str) -> Vec<Span> {
    let Some(captures) = parse_captures(language, source) else {
        return Vec::new();
    };
    segments_from_captures(source, &captures)
}

/// Compile `language`'s highlight queries, in the grammar's application order.
///
/// This is the hoisted query-compilation step: the one-shot [`parse_captures`]
/// compiles on every call, while [`IncrementalHighlighter`] compiles once in
/// [`IncrementalHighlighter::new`] and reuses the same `Query`s for every
/// append. `None` when a query fails to compile.
fn compile_queries(language: Language, ts_language: &TsLanguage) -> Option<Vec<Query>> {
    language
        .highlights_queries()
        .iter()
        .map(|query_source| Query::new(ts_language, query_source).ok())
        .collect()
}

/// Run the compiled `queries` over `root` and collect the styled captures.
///
/// Unstyled captures (punctuation / unknown names) are dropped — they map to
/// the default style and `segments_from_captures` fills their gaps.
fn collect_captures(queries: &[Query], root: Node, source: &str) -> Vec<Capture> {
    let mut captures = Vec::new();
    for query in queries {
        let mut cursor = QueryCursor::new();
        let mut stream = cursor.captures(query, root, source.as_bytes());
        while let Some((mat, index)) = stream.next() {
            let capture = mat.captures[*index];
            let name = query.capture_names()[capture.index as usize];
            let style = style_for_capture(name);
            if style == Style::new() {
                continue; // punctuation / unknown — leave the default style
            }
            let node = capture.node;
            captures.push((node.start_byte(), node.end_byte(), style));
        }
    }
    captures
}

/// Parse `source` with `language`'s grammar and collect the styled captures.
/// `None` when the grammar fails to load, the parse fails, or a highlight
/// query fails to compile (all should be impossible with the bundled
/// grammars — the error tolerance keeps the engine safe).
fn parse_captures(language: Language, source: &str) -> Option<Vec<Capture>> {
    let ts_language: TsLanguage = language.grammar().into();
    let mut parser = Parser::new();
    parser.set_language(&ts_language).ok()?;
    let tree = parser.parse(source, None)?;
    let queries = compile_queries(language, &ts_language)?;
    Some(collect_captures(&queries, tree.root_node(), source))
}

/// An incremental token highlighter.
///
/// Buffers the accumulated source and re-parses only the tail on each append,
/// reusing the previous tree so tree-sitter skips the untouched head. The
/// highlight queries are compiled once here — the one-shot [`highlight`] path
/// recompiles them per call. Each [`append`](Self::append) returns the
/// complete span stream for the accumulated text, with the same coverage
/// contract as [`highlight`].
pub struct IncrementalHighlighter {
    /// The language being highlighted (also the parser's grammar).
    language: Language,
    /// The parser, kept across appends so incremental parses can reuse state.
    parser: Parser,
    /// The most recent parse tree; `None` before the first append or after
    /// [`reset`](Self::reset).
    tree: Option<Tree>,
    /// The accumulated source, in sync with `tree`.
    source: String,
    /// `language`'s highlight queries, compiled once in
    /// [`new`](Self::new).
    queries: Vec<Query>,
    /// The byte span the last incremental parse reworked — the union of the
    /// changed ranges between the pre-append and post-append trees.
    /// `(0, 0)` before the first append or after `reset`.
    last_changed: (usize, usize),
}

impl IncrementalHighlighter {
    /// Build a highlighter for `language`. `None` when the grammar fails to
    /// load or a highlight query fails to compile (mirrors [`parse_captures`]).
    pub fn new(language: Language) -> Option<Self> {
        let ts_language: TsLanguage = language.grammar().into();
        let mut parser = Parser::new();
        parser.set_language(&ts_language).ok()?;
        let queries = compile_queries(language, &ts_language)?;
        Some(Self {
            language,
            parser,
            tree: None,
            source: String::new(),
            queries,
            last_changed: (0, 0),
        })
    }

    /// Append `chunk` to the buffered source and return the complete span
    /// stream for the accumulated text (gaps get the default style, equal-style
    /// neighbors merge, concatenation reconstructs the source).
    ///
    /// The parse is incremental: the previous tree is edited to reflect the
    /// append and passed as the old tree, so tree-sitter re-parses only the
    /// tail. An empty chunk is a no-op returning an empty stream.
    pub fn append(&mut self, chunk: &str) -> Vec<Span> {
        if chunk.is_empty() {
            return Vec::new();
        }
        let old_len = self.source.len();
        let old_end = self
            .tree
            .as_ref()
            .map(|tree| tree.root_node().end_position())
            .unwrap_or(Point::new(0, 0));
        self.source.push_str(chunk);
        let new_len = self.source.len();

        // Shift the old tree's ranges to the appended text so the parser can
        // reuse its untouched head (tree-sitter requires an edited old tree
        // matching the new text).
        if let Some(tree) = self.tree.as_mut() {
            let mut row = old_end.row;
            let mut column = old_end.column;
            for byte in chunk.bytes() {
                if byte == b'\n' {
                    row += 1;
                    column = 0;
                } else {
                    column += 1;
                }
            }
            tree.edit(&InputEdit {
                start_byte: old_len,
                old_end_byte: old_len,
                new_end_byte: new_len,
                start_position: old_end,
                old_end_position: old_end,
                new_end_position: Point::new(row, column),
            });
        }

        // Incremental parse against the (edited) previous tree. The callback
        // returns the text starting at the requested byte offset — the same
        // slicing `Parser::parse` uses internally.
        let Some(new_tree) = self.parser.parse_with_options(
            &mut |byte, _point| {
                let src = self.source.as_str();
                if byte < src.len() {
                    &src[byte..]
                } else {
                    ""
                }
            },
            self.tree.as_ref(),
            None,
        ) else {
            // Parse failure (unreachable with the bundled grammars): drop the
            // stale tree and fall back to a full one-shot parse.
            self.tree = None;
            let Some(captures) = parse_captures(self.language, &self.source) else {
                return Vec::new();
            };
            self.last_changed = (0, new_len);
            return segments_from_captures(&self.source, &captures);
        };

        // The reworked span: the union of the changed ranges between the
        // edited old tree and the new tree — the whole source on the first
        // append, when there is no old tree to reuse.
        self.last_changed = match self.tree.as_ref() {
            Some(old) => {
                let ranges: Vec<(usize, usize)> = old
                    .changed_ranges(&new_tree)
                    .map(|r| (r.start_byte, r.end_byte))
                    .collect();
                (
                    ranges.iter().map(|&(start, _)| start).min().unwrap_or(old_len),
                    ranges.iter().map(|&(_, end)| end).max().unwrap_or(new_len),
                )
            }
            None => (0, new_len),
        };

        let root = new_tree.root_node();
        let captures = collect_captures(&self.queries, root, &self.source);
        self.tree = Some(new_tree);
        segments_from_captures(&self.source, &captures)
    }

    /// Drop the buffered source and the parse tree; the next
    /// [`append`](Self::append) is a full parse from scratch.
    pub fn reset(&mut self) {
        self.tree = None;
        self.source.clear();
        self.last_changed = (0, 0);
    }

    /// The byte span the last incremental parse actually reworked — the union
    /// of `old_tree.changed_ranges(new_tree)`, the "instrumented node count"
    /// proxy. `(0, 0)` before the first append or after [`reset`](Self::reset).
    pub fn last_changed_span(&self) -> (usize, usize) {
        self.last_changed
    }
}

/// Fold styled captures into a complete, merged span stream over `source`.
///
/// Every interval between consecutive capture boundaries is covered: the most
/// specific (smallest range) capture spanning it wins, otherwise the default
/// style. Equal-range captures resolve to the later one — tree-sitter queries
/// conventionally list generic patterns (`(identifier) @variable`) before
/// specific overrides (`(function_declaration name: (identifier) @function)`)
/// and later patterns are applied on top. Equal-style neighbors merge, so the
/// concatenation reconstructs `source` exactly.
fn segments_from_captures(source: &str, captures: &[Capture]) -> Vec<Span> {
    let mut bounds: Vec<usize> = captures
        .iter()
        .flat_map(|&(start, end, _)| [start, end])
        .collect();
    bounds.push(0);
    bounds.push(source.len());
    bounds.sort_unstable();
    bounds.dedup();

    let mut spans: Vec<Span> = Vec::new();
    for pair in bounds.windows(2) {
        let (start, end) = (pair[0], pair[1]);
        if start >= end {
            continue;
        }
        // Most specific covering capture: the smallest range that spans the
        // interval wins (tree-sitter cuts on char boundaries, so slicing is
        // safe); on an equal range the later capture wins.
        let mut best: Option<(usize, Style)> = None;
        for (cstart, cend, style) in captures {
            if *cstart <= start && *cend >= end {
                let len = *cend - *cstart;
                if best.as_ref().is_none_or(|(blen, _)| len <= *blen) {
                    best = Some((len, style.clone()));
                }
            }
        }
        let style = best.map_or(Style::new(), |(_, style)| style);
        let text = &source[start..end];
        match spans.last_mut() {
            Some(last) if last.style == style => last.text.push_str(text),
            _ => spans.push(Span {
                text: text.to_string(),
                style,
            }),
        }
    }
    spans
}

#[cfg(test)]
mod tests;
