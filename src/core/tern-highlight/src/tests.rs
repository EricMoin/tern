//! Tests for the syntax highlighter.

use super::*;

use tern_core::buffer::Buffer;

use tern_core::color::Color;

/// Concatenated span text — must reconstruct the source exactly.
fn concat(spans: &[Span]) -> String {
    spans.iter().map(|s| s.text.as_str()).collect()
}

/// The first span whose text equals `text`.
fn span<'a>(spans: &'a [Span], text: &str) -> &'a Span {
    spans
        .iter()
        .find(|s| s.text == text)
        .unwrap_or_else(|| panic!("no span with text {text:?} in {spans:?}"))
}

fn fg_of(span: &Span) -> Option<(u8, u8, u8)> {
    span.style.fg.rgb()
}

#[test]
fn highlight_reconstructs_source_exactly_for_every_language() {
    let cases: &[(Language, &str)] = &[
        (Language::Rust, "fn main() {\n    let x = 42; // hi\n}\n"),
        (
            Language::TypeScript,
            "function f(a: number): string { return \"hi\"; }\n",
        ),
        (Language::JavaScript, "const f = () => 1; // hi\n"),
        (Language::Json, "{\n  \"key\": true,\n  \"n\": 1.5\n}\n"),
        (
            Language::Shell,
            "#!/bin/sh\n# comment\necho \"hello $name\"\n",
        ),
        (Language::Python, "def add(a, b):\n    return a + b  # sum\n"),
        (
            Language::Go,
            "package main\n\nfunc add(a, b int) int {\n    return a + b\n}\n",
        ),
        (Language::Toml, "[package]\nname = \"tern\"\n# comment\n"),
        (Language::Yaml, "name: tern\nversion: 0.2.0\n# comment\n"),
        (
            Language::C,
            "int main(void) {\n    return 0; // ok\n}\n",
        ),
        (
            Language::Cpp,
            "int main() {\n    std::cout << \"hi\";\n    return 0;\n}\n",
        ),
    ];
    for (language, source) in cases {
        let spans = highlight(*language, source);
        assert_eq!(
            concat(&spans),
            *source,
            "span stream must reconstruct source"
        );
    }
}

#[test]
fn fence_names_map_to_languages() {
    assert_eq!(Language::from_fence_name("rust"), Some(Language::Rust));
    assert_eq!(Language::from_fence_name("rs"), Some(Language::Rust));
    assert_eq!(
        Language::from_fence_name("typescript"),
        Some(Language::TypeScript)
    );
    assert_eq!(Language::from_fence_name("ts"), Some(Language::TypeScript));
    assert_eq!(Language::from_fence_name("tsx"), Some(Language::Tsx));
    assert_eq!(Language::from_fence_name("json"), Some(Language::Json));
    assert_eq!(
        Language::from_fence_name("javascript"),
        Some(Language::JavaScript)
    );
    assert_eq!(Language::from_fence_name("js"), Some(Language::JavaScript));
    assert_eq!(Language::from_fence_name("jsx"), Some(Language::JavaScript));
    assert_eq!(Language::from_fence_name("bash"), Some(Language::Shell));
    assert_eq!(Language::from_fence_name("shell"), Some(Language::Shell));
    assert_eq!(Language::from_fence_name("sh"), Some(Language::Shell));
    assert_eq!(Language::from_fence_name("zsh"), Some(Language::Shell));
    assert_eq!(Language::from_fence_name("python"), Some(Language::Python));
    assert_eq!(Language::from_fence_name("py"), Some(Language::Python));
    assert_eq!(Language::from_fence_name("go"), Some(Language::Go));
    assert_eq!(Language::from_fence_name("golang"), Some(Language::Go));
    assert_eq!(Language::from_fence_name("toml"), Some(Language::Toml));
    assert_eq!(Language::from_fence_name("yaml"), Some(Language::Yaml));
    assert_eq!(Language::from_fence_name("yml"), Some(Language::Yaml));
    assert_eq!(Language::from_fence_name("c"), Some(Language::C));
    assert_eq!(Language::from_fence_name("cpp"), Some(Language::Cpp));
    assert_eq!(Language::from_fence_name("c++"), Some(Language::Cpp));
    assert_eq!(Language::from_fence_name("cxx"), Some(Language::Cpp));
    assert_eq!(Language::from_fence_name("RUST"), Some(Language::Rust));
    assert_eq!(Language::from_fence_name("PYTHON"), Some(Language::Python));
    assert_eq!(Language::from_fence_name("ruby"), None);
    assert_eq!(Language::from_fence_name("markdown"), None);
    assert_eq!(Language::from_fence_name("md"), None);
    assert_eq!(Language::from_fence_name(""), None);
}

#[test]
fn rust_keyword_function_string_comment_and_number_tokens_get_styles() {
    let source = "fn main() {\n    let x = 42; // the answer\n}\n";
    let spans = highlight(Language::Rust, source);

    // `fn` is a keyword (purple).
    let kw = span(&spans, "fn");
    assert_eq!(fg_of(kw), Some(KEYWORD_FG));
    assert!(!kw.style.modifiers.contains(Modifiers::ITALIC));

    // `main` is a function name (blue).
    assert_eq!(fg_of(span(&spans, "main")), Some(FUNCTION_FG));

    // `42` is an integer literal -> `@constant.builtin` (orange).
    assert_eq!(fg_of(span(&spans, "42")), Some(NUMBER_FG));

    // The comment is italic grey.
    let comment = span(&spans, "// the answer");
    assert_eq!(fg_of(comment), Some(COMMENT_FG));
    assert!(comment.style.modifiers.contains(Modifiers::ITALIC));

    // The string literal is green.
    let string = "println!(\"{x}\")";
    let src2 = "fn main() {\n    println!(\"{x}\");\n}\n";
    let spans2 = highlight(Language::Rust, src2);
    assert_eq!(fg_of(span(&spans2, "\"{x}\"")), Some(STRING_FG));
    // The macro invocation name is a function (blue).
    assert_eq!(fg_of(span(&spans2, "println!")), Some(FUNCTION_FG));

    // Punctuation carries the default style and merges into its neighbors.
    assert_eq!(concat(&spans), source);
    assert!(spans
        .iter()
        .all(|s| s.style == Style::new() || s.style.fg != Color::Default));
    let _ = string;
}

#[test]
fn json_strings_numbers_and_keywords_get_styles() {
    let source = "{\n  \"key\": true,\n  \"n\": 1.5,\n  \"s\": \"text\"\n}\n";
    let spans = highlight(Language::Json, source);
    assert_eq!(concat(&spans), source);
    // JSON object keys are `@string.special.key` (green).
    assert_eq!(fg_of(span(&spans, "\"key\"")), Some(STRING_FG));
    // `true` is `@constant.builtin` (orange).
    assert_eq!(fg_of(span(&spans, "true")), Some(NUMBER_FG));
    // Numbers are `@number` (orange).
    assert_eq!(fg_of(span(&spans, "1.5")), Some(NUMBER_FG));
    // String values are `@string` (green).
    assert_eq!(fg_of(span(&spans, "\"text\"")), Some(STRING_FG));
}

#[test]
fn shell_comments_strings_and_functions_get_styles() {
    let source = "#!/bin/sh\n# a comment\necho \"hello\"\n";
    let spans = highlight(Language::Shell, source);
    assert_eq!(concat(&spans), source);
    assert_eq!(fg_of(span(&spans, "# a comment")), Some(COMMENT_FG));
    assert_eq!(fg_of(span(&spans, "\"hello\"")), Some(STRING_FG));
}

#[test]
fn typescript_keywords_and_types_get_styles() {
    let source = "function f(a: number): string { return \"hi\"; }\n";
    let spans = highlight(Language::TypeScript, source);
    assert_eq!(concat(&spans), source);
    // `function` and `return` are keywords (purple) — captured by the
    // complementing JavaScript highlight query.
    assert_eq!(fg_of(span(&spans, "function")), Some(KEYWORD_FG));
    assert_eq!(fg_of(span(&spans, "return")), Some(KEYWORD_FG));
    // `number` / `string` annotations are `@type.builtin` (yellow).
    assert_eq!(fg_of(span(&spans, "number")), Some(TYPE_FG));
    assert_eq!(fg_of(span(&spans, "string")), Some(TYPE_FG));
    // `f` is a function name (blue) — the specific `@function` capture
    // beats the generic JS `@variable` on the same identifier.
    assert_eq!(fg_of(span(&spans, "f")), Some(FUNCTION_FG));
    // The string literal is green.
    assert_eq!(fg_of(span(&spans, "\"hi\"")), Some(STRING_FG));
}

#[test]
fn empty_and_unknown_input_yield_empty_spans() {
    assert!(highlight(Language::Rust, "").is_empty());
    // Error-tolerant parsing on garbage still yields a complete stream
    // (the streaming contract) — the concatenation reconstructs input.
    let garbage = highlight(Language::Json, "not json at all {{{");
    assert_eq!(concat(&garbage), "not json at all {{{");
    // A half-open snippet still produces tokens — the stream must at
    // least reconstruct input.
    let half = "fn main() {\n    let x = ";
    let spans = highlight(Language::Rust, half);
    assert_eq!(concat(&spans), half);
}

/// Paint a span stream into a `width`-wide buffer, wrapping at the right
/// edge and on newlines, honoring per-span styles (never splitting a
/// multi-width glyph).
fn paint_spans(spans: &[Span], width: u16, height: u16) -> Buffer {
    let mut buf = Buffer::new(width, height);
    let (mut col, mut row) = (0u16, 0u16);
    for span in spans {
        for ch in span.text.chars() {
            if ch == '\n' {
                row += 1;
                col = 0;
                continue;
            }
            let w = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0) as u16;
            if col + w > width {
                row += 1;
                col = 0;
            }
            if row >= height {
                break;
            }
            buf.set_char(col, row, ch, span.style.clone());
            col += w;
        }
    }
    buf
}

#[test]
fn golden_rust_snippet_token_colors() {
    let source = "fn main() {\n    let x = 42; // the answer\n    println!(\"ok\");\n}\n";
    let spans = highlight(Language::Rust, source);

    let buffer = paint_spans(&spans, 40, 5);

    // Row 0: `fn main() {` — fn keyword purple, main function blue.
    assert_eq!(buffer.cell(0, 0).unwrap().ch, 'f');
    assert_eq!(
        buffer.cell(0, 0).unwrap().style.fg,
        Color::Rgb(198, 120, 221)
    );
    assert_eq!(buffer.cell(1, 0).unwrap().ch, 'n');
    assert_eq!(buffer.cell(3, 0).unwrap().ch, 'm');
    assert_eq!(
        buffer.cell(3, 0).unwrap().style.fg,
        Color::Rgb(97, 175, 239)
    );
    // Punctuation `(` / `)` / `{` carry the default style.
    assert_eq!(buffer.cell(7, 0).unwrap().style.fg, Color::Default);
    assert_eq!(buffer.cell(9, 0).unwrap().style.fg, Color::Default);

    // Row 1: `    let x = 42;` — `let` keyword purple, `42` number orange.
    assert_eq!(buffer.cell(4, 1).unwrap().ch, 'l');
    assert_eq!(
        buffer.cell(4, 1).unwrap().style.fg,
        Color::Rgb(198, 120, 221)
    );
    assert_eq!(buffer.cell(12, 1).unwrap().ch, '4');
    assert_eq!(
        buffer.cell(12, 1).unwrap().style.fg,
        Color::Rgb(209, 154, 102)
    );

    // The trailing comment `// the answer` is italic grey.
    let comment_start = buffer.cell(16, 1).unwrap();
    assert_eq!(comment_start.ch, '/');
    assert_eq!(comment_start.style.fg, Color::Rgb(127, 132, 142));
    assert!(comment_start.style.modifiers.contains(Modifiers::ITALIC));

    // Row 2: the string literal is green.
    assert_eq!(buffer.cell(13, 2).unwrap().ch, '"');
    assert_eq!(
        buffer.cell(13, 2).unwrap().style.fg,
        Color::Rgb(152, 195, 121)
    );

    // Golden: the full painted buffer equals the expected cell grid with
    // pinned styles (glyphs for rows 0-2, blank beyond).
    let mut expected = Buffer::new(40, 5);
    let default = Style::new();
    let pin = |buf: &mut Buffer, y: u16, text: &str, style: Style| {
        for (x, ch) in text.chars().enumerate() {
            buf.set_char(x as u16, y, ch, style.clone());
        }
    };
    pin(&mut expected, 0, "fn main() {", default.clone());
    // fn (keyword), main (function) — write the pinned styles cell by cell.
    for x in 0..2 {
        expected.set_char(x, 0, "fn".chars().nth(x as usize).unwrap(), fg(KEYWORD_FG));
    }
    expected.set_char(2, 0, ' ', default.clone());
    for (i, ch) in "main".chars().enumerate() {
        expected.set_char(3 + i as u16, 0, ch, fg(FUNCTION_FG));
    }
    expected.set_char(7, 0, '(', default.clone());
    expected.set_char(8, 0, ')', default.clone());
    expected.set_char(9, 0, ' ', default.clone());
    expected.set_char(10, 0, '{', default.clone());
    pin(&mut expected, 1, "    let x = 42; // the answer", default.clone());
    for (i, ch) in "let".chars().enumerate() {
        expected.set_char(4 + i as u16, 1, ch, fg(KEYWORD_FG));
    }
    expected.set_char(12, 1, '4', fg(NUMBER_FG));
    expected.set_char(13, 1, '2', fg(NUMBER_FG));
    for (i, ch) in "// the answer".chars().enumerate() {
        expected.set_char(
            16 + i as u16,
            1,
            ch,
            fg(COMMENT_FG).add_modifier(Modifiers::ITALIC),
        );
    }
    pin(&mut expected, 2, "    println!(\"ok\");", default.clone());
    for (i, ch) in "println!".chars().enumerate() {
        expected.set_char(4 + i as u16, 2, ch, fg(FUNCTION_FG));
    }
    expected.set_char(12, 2, '(', default.clone());
    for (i, ch) in "\"ok\"".chars().enumerate() {
        expected.set_char(13 + i as u16, 2, ch, fg(STRING_FG));
    }
    expected.set_char(17, 2, ')', default.clone());
    expected.set_char(18, 2, ';', default.clone());
    pin(&mut expected, 3, "}", default.clone());

    assert_eq!(buffer, expected);
}

/// Pin one row of the expected buffer: each `(start_x, text, style)`
/// segment paints its glyphs left-to-right from `start_x`.
fn pin_row(buf: &mut Buffer, y: u16, segments: &[(usize, &str, Style)]) {
    for &(x, text, ref style) in segments {
        for (i, ch) in text.chars().enumerate() {
            buf.set_char(x as u16 + i as u16, y, ch, style.clone());
        }
    }
}

/// The shared golden-buffer harness (mirrors
/// `golden_rust_snippet_token_colors`): highlight `source`, verify the
/// span stream reconstructs it, paint into a buffer, and assert the full
/// painted grid equals the pinned expectation (per-cell glyphs + fg).
fn assert_golden(language: Language, source: &str, width: u16, height: u16, rows: &[&[(usize, &str, Style)]]) {
    let spans = highlight(language, source);
    assert_eq!(concat(&spans), source, "span stream must reconstruct source");
    let buffer = paint_spans(&spans, width, height);
    let mut expected = Buffer::new(width, height);
    for (y, segments) in rows.iter().enumerate() {
        pin_row(&mut expected, y as u16, segments);
    }
    assert_eq!(buffer, expected);
}

#[test]
fn golden_python_snippet_token_colors() {
    assert_golden(
        Language::Python,
        "def add(a, b):\n    return a + b  # sum\n",
        40,
        3,
        &[
            // `def` keyword, `add` function, `a`/`b` parameters.
            &[
                (0, "def", fg(KEYWORD_FG)),
                (3, " ", Style::new()),
                (4, "add", fg(FUNCTION_FG)),
                (7, "(", Style::new()),
                (8, "a", fg(VARIABLE_FG)),
                (9, ", ", Style::new()),
                (11, "b", fg(VARIABLE_FG)),
                (12, "):", Style::new()),
            ],
            // `return` keyword, `a`/`b` parameters, `+` operator, comment.
            &[
                (0, "    ", Style::new()),
                (4, "return", fg(KEYWORD_FG)),
                (10, " ", Style::new()),
                (11, "a", fg(VARIABLE_FG)),
                (12, " ", Style::new()),
                (13, "+", fg(BUILTIN_FG)),
                (14, " ", Style::new()),
                (15, "b", fg(VARIABLE_FG)),
                (16, "  ", Style::new()),
                (18, "# sum", fg(COMMENT_FG).add_modifier(Modifiers::ITALIC)),
            ],
        ],
    );
}

#[test]
fn golden_go_snippet_token_colors() {
    assert_golden(
        Language::Go,
        "package main\n\nfunc add(a, b int) int {\n    return a + b\n}\n",
        40,
        6,
        &[
            // `package` keyword; the package name carries no capture.
            &[(0, "package", fg(KEYWORD_FG)), (7, " main", Style::new())],
            // Row 1: blank.
            &[],
            // `func` keyword, `add` (the later generic `(identifier)
            // @variable` capture wins on tie over `@function`), `a`/`b`
            // parameters, `int` types.
            &[
                (0, "func", fg(KEYWORD_FG)),
                (4, " ", Style::new()),
                (5, "add", fg(VARIABLE_FG)),
                (8, "(", Style::new()),
                (9, "a", fg(VARIABLE_FG)),
                (10, ", ", Style::new()),
                (12, "b", fg(VARIABLE_FG)),
                (13, " ", Style::new()),
                (14, "int", fg(TYPE_FG)),
                (17, ") ", Style::new()),
                (19, "int", fg(TYPE_FG)),
                (22, " {", Style::new()),
            ],
            // `return` keyword, `a`/`b`, `+` operator.
            &[
                (0, "    ", Style::new()),
                (4, "return", fg(KEYWORD_FG)),
                (10, " ", Style::new()),
                (11, "a", fg(VARIABLE_FG)),
                (12, " ", Style::new()),
                (13, "+", fg(BUILTIN_FG)),
                (14, " ", Style::new()),
                (15, "b", fg(VARIABLE_FG)),
            ],
            &[(0, "}", Style::new())],
        ],
    );
}

#[test]
fn golden_toml_snippet_token_colors() {
    assert_golden(
        Language::Toml,
        "[package]\nname = \"tern\"\nversion = \"0.2.0\"\n# comment\n",
        40,
        5,
        &[
            // `[package]` — `package` is a bare_key under a table:
            // `(bare_key) @type` is the smallest covering capture.
            &[
                (0, "[", Style::new()),
                (1, "package", fg(TYPE_FG)),
                (8, "]", Style::new()),
            ],
            // `name = "tern"` — the pair-level `(pair ...) @property`
            // capture spans the whole `k = v` and wins on the gap cells
            // (the spaces either side of `=`); the bare_key `@type`, the
            // `"=" @operator` and the string `@string` are each more
            // specific on their own cells.
            &[
                (0, "name", fg(TYPE_FG)),
                (4, " ", fg(VARIABLE_FG)),
                (5, "=", fg(BUILTIN_FG)),
                (6, " ", fg(VARIABLE_FG)),
                (7, "\"tern\"", fg(STRING_FG)),
            ],
            // Same shape for `version`.
            &[
                (0, "version", fg(TYPE_FG)),
                (7, " ", fg(VARIABLE_FG)),
                (8, "=", fg(BUILTIN_FG)),
                (9, " ", fg(VARIABLE_FG)),
                (10, "\"0.2.0\"", fg(STRING_FG)),
            ],
            // Comment.
            &[(0, "# comment", fg(COMMENT_FG).add_modifier(Modifiers::ITALIC))],
        ],
    );
}

#[test]
fn golden_yaml_snippet_token_colors() {
    assert_golden(
        Language::Yaml,
        "name: tern\nversion: 0.2.0\n# comment\n",
        40,
        4,
        &[
            // `name` key is `@property`; the plain scalar value `tern`
            // is `@string`.
            &[
                (0, "name", fg(VARIABLE_FG)),
                (4, ": ", Style::new()),
                (6, "tern", fg(STRING_FG)),
            ],
            &[
                (0, "version", fg(VARIABLE_FG)),
                (7, ": ", Style::new()),
                (9, "0.2.0", fg(STRING_FG)),
            ],
            &[(0, "# comment", fg(COMMENT_FG).add_modifier(Modifiers::ITALIC))],
        ],
    );
}

#[test]
fn golden_c_snippet_token_colors() {
    assert_golden(
        Language::C,
        "int main(void) {\n    return 0; // ok\n}\n",
        40,
        4,
        &[
            // `int` / `void` primitive types, `main` function.
            &[
                (0, "int", fg(TYPE_FG)),
                (3, " ", Style::new()),
                (4, "main", fg(FUNCTION_FG)),
                (8, "(", Style::new()),
                (9, "void", fg(TYPE_FG)),
                (13, ") {", Style::new()),
            ],
            // `return` keyword, `0` number, `// ok` comment.
            &[
                (0, "    ", Style::new()),
                (4, "return", fg(KEYWORD_FG)),
                (10, " ", Style::new()),
                (11, "0", fg(NUMBER_FG)),
                (12, "; ", Style::new()),
                (14, "// ok", fg(COMMENT_FG).add_modifier(Modifiers::ITALIC)),
            ],
            &[(0, "}", Style::new())],
        ],
    );
}

#[test]
fn golden_cpp_snippet_token_colors() {
    assert_golden(
        Language::Cpp,
        "int main() {\n    std::cout << \"hi\";\n    return 0;\n}\n",
        40,
        5,
        &[
            // `int` type and `main` function come from the C query; the
            // C++ query adds nothing on this row.
            &[
                (0, "int", fg(TYPE_FG)),
                (3, " ", Style::new()),
                (4, "main", fg(FUNCTION_FG)),
                (8, "() {", Style::new()),
            ],
            // `std::` unstyled (lowercase namespace misses the C++ `@type`
            // match predicate), `cout` field property (C query), `<<` has
            // no operator capture in either query, string (C query).
            &[
                (0, "    ", Style::new()),
                (4, "std::", Style::new()),
                (9, "cout", fg(VARIABLE_FG)),
                (13, " << ", Style::new()),
                (17, "\"hi\"", fg(STRING_FG)),
                (21, ";", Style::new()),
            ],
            // `return` keyword, `0` number (both C query).
            &[
                (0, "    ", Style::new()),
                (4, "return", fg(KEYWORD_FG)),
                (10, " ", Style::new()),
                (11, "0", fg(NUMBER_FG)),
                (12, ";", Style::new()),
            ],
            &[(0, "}", Style::new())],
        ],
    );
}

/// A large, well-formed Rust source (2048 complete top-level items) for
/// exercising incremental re-parsing. Ends on a clean item boundary so an
/// appended chunk re-parses only the tail.
fn big_rust_fence() -> String {
    let mut src = String::with_capacity(64 * 2048);
    src.push_str("// generated fence\n");
    for i in 0..2048 {
        src.push_str(&format!("fn f{i:04}() -> u32 {{ {i} }}\n"));
    }
    src
}

#[test]
fn incremental_append_reworks_only_the_tail() {
    let mut hl = IncrementalHighlighter::new(Language::Rust).expect("rust grammar/query load");
    let fence = big_rust_fence();
    hl.append(&fence);

    let tail = "fn tail() -> u32 { 0 }\n";
    hl.append(tail);

    let (start, end) = hl.last_changed_span();
    let changed = end - start;
    assert!(
        changed <= tail.len() + 64,
        "incremental parse reworked {changed} bytes ({start}..{end}), \
         expected at most {} (tail) + 64 (token-boundary slack)",
        tail.len()
    );
}

#[test]
fn incremental_spans_are_byte_identical_to_full_highlight() {
    let fence = big_rust_fence();
    let tail = "fn tail() -> u32 { 0 }\n";
    let full = format!("{fence}{tail}");

    let mut hl = IncrementalHighlighter::new(Language::Rust).expect("rust grammar/query load");
    // Feed the fence in line-group chunks, then the tail — several
    // incremental parses before the final comparison.
    for group in fence.lines().collect::<Vec<_>>().chunks(512) {
        let mut part = String::new();
        for line in group {
            part.push_str(line);
            part.push('\n');
        }
        hl.append(&part);
    }
    let incremental = hl.append(tail);

    let one_shot = highlight(Language::Rust, &full);
    assert_eq!(
        incremental.len(),
        one_shot.len(),
        "span counts differ ({} vs {})",
        incremental.len(),
        one_shot.len()
    );
    for (i, (inc, one)) in incremental.iter().zip(one_shot.iter()).enumerate() {
        assert_eq!(inc.text, one.text, "span {i} text differs");
        assert_eq!(inc.style, one.style, "span {i} style differs");
    }
    assert_eq!(
        concat(&incremental),
        full,
        "incremental stream must reconstruct the source"
    );
}

#[test]
fn fresh_one_shot_parse_marks_the_whole_source_changed() {
    let mut hl = IncrementalHighlighter::new(Language::Rust).expect("rust grammar/query load");
    let fence = big_rust_fence();
    hl.append(&fence);
    // No prior tree to reuse: the whole source is the changed span,
    // contrasting with the tail-only rework of the incremental case.
    assert_eq!(hl.last_changed_span(), (0, fence.len()));
}

#[test]
fn incremental_reset_starts_a_fresh_full_parse() {
    let mut hl = IncrementalHighlighter::new(Language::Rust).expect("rust grammar/query load");
    hl.append(&big_rust_fence());
    hl.reset();
    assert_eq!(hl.last_changed_span(), (0, 0));
    let fence = "fn reset() {}\n";
    let spans = hl.append(fence);
    assert_eq!(concat(&spans), fence);
    assert_eq!(hl.last_changed_span(), (0, fence.len()));
}

/// Assert `spans` is byte-identical to a full one-shot highlight of `source`
/// — same span texts and styles in the same order — and reconstructs it.
fn assert_matches_full_highlight(spans: &[Span], source: &str) {
    let one_shot = highlight(Language::Rust, source);
    assert_eq!(concat(spans), source, "the stream must reconstruct the source");
    assert_eq!(
        spans.len(),
        one_shot.len(),
        "span counts differ ({} vs {})",
        spans.len(),
        one_shot.len()
    );
    for (i, (inc, one)) in spans.iter().zip(one_shot.iter()).enumerate() {
        assert_eq!(inc.text, one.text, "span {i} text differs");
        assert_eq!(inc.style, one.style, "span {i} style differs");
    }
}

#[test]
fn apply_edit_spans_are_byte_identical_to_full_highlight() {
    let fence = big_rust_fence();
    let mut hl = IncrementalHighlighter::new(Language::Rust).expect("rust grammar/query load");
    hl.append(&fence);

    // A mid-file replacement — the change a pure append cannot express and
    // the reason apply_edit exists.
    let needle = "fn f0100()";
    let at = fence.find(needle).expect("generated item in the fence");
    let renamed = "fn renamed_0100()";
    let mut edited = fence.clone();
    edited.replace_range(at..at + needle.len(), renamed);
    let spans = hl.apply_edit(at, at + needle.len(), renamed);
    assert_matches_full_highlight(&spans, &edited);

    // The re-parse reworked a window around the edit, not the whole file.
    // tree-sitter reports the *structurally* changed nodes — the renamed
    // identifier — so the window need not cover the whole replaced range (the
    // unchanged `fn` keyword the edit starts on stays out of it).
    let (start, end) = hl.last_changed_span();
    assert!(
        start > 0 && end < edited.len(),
        "a mid-file edit must not rework everything ({start}..{end})"
    );
    assert!(
        end - start <= renamed.len() + 64,
        "the window stays near the edit: {} bytes for a {}-byte replacement",
        end - start,
        renamed.len()
    );
    let identifier = at + "fn ".len();
    assert!(
        start <= identifier && end >= identifier + "renamed_0100".len(),
        "the window must cover the renamed identifier ({start}..{end})"
    );

    // A pure insertion at the end of the buffer, then a pure deletion of it:
    // the buffer round-trips to the pre-insertion text.
    let tail = "fn inserted() -> u32 { 7 }\n";
    let mut inserted = edited.clone();
    inserted.push_str(tail);
    let spans = hl.apply_edit(edited.len(), edited.len(), tail);
    assert_matches_full_highlight(&spans, &inserted);

    let from = inserted.find("fn inserted()").expect("inserted item");
    let spans = hl.apply_edit(from, from + tail.len(), "");
    assert_matches_full_highlight(&spans, &edited);
}

#[test]
fn apply_edit_reparses_around_multibyte_characters() {
    let source = "fn main() {\n    let s = \"héllo → wörld\"; // ünïcode\n}\n";
    let literal = "\"héllo → wörld\"";
    // Byte offsets, not characters: 15 characters, 19 bytes.
    assert_eq!(literal.len(), 19);
    let at = source.find(literal).expect("string literal in the source");
    let edited = source.replace(literal, "\"bye\"");

    let mut hl = IncrementalHighlighter::new(Language::Rust).expect("rust grammar/query load");
    hl.append(source);
    let spans = hl.apply_edit(at, at + literal.len(), "\"bye\"");
    assert_matches_full_highlight(&spans, &edited);
}

#[test]
fn apply_edit_out_of_range_is_a_no_op() {
    let mut hl = IncrementalHighlighter::new(Language::Rust).expect("rust grammar/query load");
    hl.append("fn é() {}\n");
    // Past the end of the buffer, inverted, and inside the two-byte é.
    assert!(hl.apply_edit(99, 99, "x").is_empty(), "past the end");
    assert!(hl.apply_edit(5, 2, "").is_empty(), "inverted");
    assert!(hl.apply_edit(4, 4, "x").is_empty(), "mid-character");
    assert_eq!(hl.last_changed_span(), (0, 0));
    // The buffer survived: an edit from its head still sees the original text.
    let spans = hl.apply_edit(0, 0, "// hi\n");
    assert_matches_full_highlight(&spans, "// hi\nfn é() {}\n");
}

#[test]
fn apply_edit_window_slices_only_the_changed_bytes() {
    // A hand-built stream over "abcdefghi": [abc][defg][hi].
    let stream = vec![
        Span { text: "abc".to_string(), style: fg(KEYWORD_FG) },
        Span { text: "defg".to_string(), style: Style::new() },
        Span { text: "hi".to_string(), style: fg(STRING_FG) },
    ];
    // A window cutting two spans keeps their bytes and their styles.
    let window = spans_in_window(&stream, 1, 8);
    assert_eq!(concat(&window), "bcdefgh");
    assert_eq!(window.len(), 3, "both cut spans stay separate: {window:?}");
    assert_eq!(window[0].style, fg(KEYWORD_FG));
    assert_eq!(window[1].style, Style::new());
    assert_eq!(window[2].style, fg(STRING_FG));
    // Equal-style neighbours merge back together inside the window.
    let same = vec![
        Span { text: "abc".to_string(), style: Style::new() },
        Span { text: "def".to_string(), style: Style::new() },
    ];
    assert_eq!(concat(&spans_in_window(&same, 1, 5)), "bcde");
    assert_eq!(spans_in_window(&same, 1, 5).len(), 1);
    // Clamping, empty and inverted windows.
    assert_eq!(concat(&spans_in_window(&stream, 4, usize::MAX)), "efghi");
    assert!(spans_in_window(&stream, 5, 5).is_empty());
    assert!(spans_in_window(&stream, 7, 2).is_empty());
    // A boundary inside a multi-byte character widens outward, never panics.
    let wide = vec![Span { text: "é!".to_string(), style: Style::new() }];
    assert_eq!(concat(&spans_in_window(&wide, 1, 3)), "é!");
}
