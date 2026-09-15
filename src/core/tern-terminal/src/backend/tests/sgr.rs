//! SGR emission: palette quantization, truecolor, extended underlines, and
//! modifiers.

use super::*;

#[test]
fn rgb_to_ansi256_picks_nearest_palette_index() {
    // Pure red is exactly the cube entry (255, 0, 0) -> 16 + 36*5.
    assert_eq!(rgb_to_ansi256(255, 0, 0), 196);
    // Pure black is exactly (0, 0, 0) -> cube index 16 (the grayscale
    // ramp's darkest is (8, 8, 8), farther away).
    assert_eq!(rgb_to_ansi256(0, 0, 0), 16);
    // Pure white is exactly (255, 255, 255) -> cube index 231.
    assert_eq!(rgb_to_ansi256(255, 255, 255), 231);
    // Mid gray is exactly the ramp value 128 (8 + 10*12) -> index 244,
    // beating the cube's (135, 135, 135) candidate.
    assert_eq!(rgb_to_ansi256(128, 128, 128), 244);
}

#[test]
fn queue_color_keeps_rgb_when_truecolor_supported() {
    let mut out = Vec::new();
    let caps = BackendCapabilities {
        truecolor: true,
        colors: 16_777_216,
        underline_styles: false,
    };
    queue_color_with(&mut out, TernColor::Rgb(1, 2, 3), true, caps)
        .expect("queue should succeed");
    let s = String::from_utf8(out).unwrap();
    assert_eq!(s, "\x1b[38;2;1;2;3m", "got: {s:?}");
}

#[test]
fn queue_color_quantizes_rgb_without_truecolor() {
    let mut out = Vec::new();
    // 256-color terminal: the RGB is quantized to the nearest palette
    // index instead of an unsupported truecolor sequence.
    let caps = BackendCapabilities {
        truecolor: false,
        colors: 256,
        underline_styles: false,
    };
    queue_color_with(&mut out, TernColor::Rgb(255, 0, 0), true, caps)
        .expect("queue should succeed");
    assert_eq!(String::from_utf8(out).unwrap(), "\x1b[38;5;196m");
    // Background variant goes through the background SGR.
    let mut out = Vec::new();
    queue_color_with(&mut out, TernColor::Rgb(128, 128, 128), false, caps)
        .expect("queue should succeed");
    assert_eq!(String::from_utf8(out).unwrap(), "\x1b[48;5;244m");
}

#[test]
fn queue_color_drops_rgb_on_a_small_palette() {
    // A basic-16-color terminal: no SGR color command at all — the
    // per-cell reset's default stays.
    let mut out = Vec::new();
    let caps = BackendCapabilities {
        truecolor: false,
        colors: 16,
        underline_styles: false,
    };
    queue_color_with(&mut out, TernColor::Rgb(255, 0, 0), true, caps)
        .expect("queue should succeed");
    assert!(out.is_empty(), "got: {:?}", out);
}

#[test]
fn queue_underline_emits_extended_sgr_when_supported() {
    // A terminal reporting extended underline support gets the kitty
    // sequences: `\x1b[4:Nm` for the style variant (3 = curly) and
    // `\x1b[58;2;r;g;bm` for the colored underline, style first.
    let caps = BackendCapabilities {
        truecolor: true,
        colors: 16_777_216,
        underline_styles: true,
    };
    let mut out = Vec::new();
    queue_underline_with(
        &mut out,
        &Style::new().underline_style(UnderlineStyle::Curly),
        caps,
    )
    .expect("queue should succeed");
    assert_eq!(String::from_utf8(out).unwrap(), "\x1b[4:3m", "curly");

    let mut out = Vec::new();
    queue_underline_with(
        &mut out,
        &Style::new().underline_color(Some(TernColor::Rgb(255, 0, 0))),
        caps,
    )
    .expect("queue should succeed");
    assert_eq!(
        String::from_utf8(out).unwrap(),
        "\x1b[58;2;255;0;0m",
        "color-only underline"
    );

    let mut out = Vec::new();
    queue_underline_with(
        &mut out,
        &Style::new()
            .underline_style(UnderlineStyle::Double)
            .underline_color(Some(TernColor::Rgb(1, 2, 3))),
        caps,
    )
    .expect("queue should succeed");
    assert_eq!(
        String::from_utf8(out).unwrap(),
        "\x1b[4:2m\x1b[58;2;1;2;3m",
        "variant then color"
    );

    // A palette underline color uses the 58;5 form.
    let mut out = Vec::new();
    queue_underline_with(
        &mut out,
        &Style::new()
            .underline_style(UnderlineStyle::Dotted)
            .underline_color(Some(TernColor::Indexed(9))),
        caps,
    )
    .expect("queue should succeed");
    assert_eq!(String::from_utf8(out).unwrap(), "\x1b[4:4m\x1b[58;5;9m");
}

#[test]
fn queue_underline_falls_back_to_plain_when_unsupported() {
    // A terminal without extended underline support degrades the
    // variant/color to the plain `\x1b[4m` underline — the text is
    // still underlined, only the styling is lost.
    let caps = BackendCapabilities {
        truecolor: true,
        colors: 16_777_216,
        underline_styles: false,
    };
    let mut out = Vec::new();
    queue_underline_with(
        &mut out,
        &Style::new().underline_style(UnderlineStyle::Curly),
        caps,
    )
    .expect("queue should succeed");
    assert_eq!(String::from_utf8(out).unwrap(), "\x1b[4m", "plain fallback");

    let mut out = Vec::new();
    queue_underline_with(
        &mut out,
        &Style::new().underline_color(Some(TernColor::Rgb(255, 0, 0))),
        caps,
    )
    .expect("queue should succeed");
    assert_eq!(String::from_utf8(out).unwrap(), "\x1b[4m", "color fallback");
}

#[test]
fn queue_underline_leaves_legacy_bit_to_the_modifier_pass() {
    // A style carrying only the legacy `Modifiers::UNDERLINE` bit (no
    // variant, no color) queues nothing here — `queue_modifiers` emits
    // `Attribute::Underlined` for it, so untouched styles stay
    // byte-identical. A style with neither the bit nor the extended
    // fields queues nothing either.
    let caps = BackendCapabilities {
        truecolor: true,
        colors: 16_777_216,
        underline_styles: true,
    };
    let mut out = Vec::new();
    queue_underline_with(
        &mut out,
        &Style::new().add_modifier(Modifiers::UNDERLINE),
        caps,
    )
    .expect("queue should succeed");
    assert!(out.is_empty(), "got: {:?}", out);

    let mut out = Vec::new();
    queue_underline_with(&mut out, &Style::new(), caps).expect("queue should succeed");
    assert!(out.is_empty(), "got: {:?}", out);
}

#[test]
fn flush_diff_extended_underline_run_emits_one_underline_command() {
    // End-to-end through the run queue (whose capabilities come from the
    // global probe, not the injectable seam): a curly-underline cell is
    // its own run whose SGR block carries exactly ONE underline command —
    // the kitty `\x1b[4:3m` when the terminal reports extended support,
    // the plain `\x1b[4m` fallback otherwise — and never both, because
    // the extended path strips the legacy bit from the modifier pass.
    let curly = Style::new().underline_style(UnderlineStyle::Curly);
    let out = flush(&[update(0, 0, 'u', curly, 1, false)], (0, 0));
    let s = String::from_utf8(out).unwrap();
    let extended = s.matches("\x1b[4:3m").count();
    let plain = s.matches("\x1b[4m").count();
    assert_eq!(extended + plain, 1, "got: {s:?}");
    assert!(s.contains("\x1b[1;1H\x1b[0m\x1b[4"), "got: {s:?}");
}

#[test]
fn flush_diff_legacy_underline_run_keeps_attribute_underlined() {
    // The legacy path is untouched: a style with only the UNDERLINE bit
    // emits `Attribute::Underlined` (`\x1b[4m`) through the modifier
    // pass, byte-identical to before the extended fields existed.
    let legacy = Style::new().add_modifier(Modifiers::UNDERLINE);
    let out = flush(&[update(0, 0, 'u', legacy, 1, false)], (0, 0));
    let s = String::from_utf8(out).unwrap();
    assert!(s.contains("\x1b[1;1H\x1b[0m\x1b[4mu"), "got: {s:?}");
    // Exactly one plain underline sequence (the run's own; the trailing
    // park resets with SGR 0, not another underline).
    assert_eq!(s.matches("\x1b[4m").count(), 1, "got: {s:?}");
}
