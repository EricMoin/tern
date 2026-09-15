//! Prop-map to taffy-style translation, including the length/percentage,
//! grid-track, and placement parsers.

use super::*;

/// Translate a scene node's `props` into a taffy `Style`.
pub(super) fn props_to_style(props: &PropMap) -> TaffyStyle {
    let length = LengthPercentage::Length;
    let dimension = Dimension::Length;
    let length_auto = LengthPercentageAuto::Length;

    let flex_direction = match prop_str(props, "flex_direction") {
        Some("column") => FlexDirection::Column,
        Some("row-reverse") => FlexDirection::RowReverse,
        Some("column-reverse") => FlexDirection::ColumnReverse,
        _ => FlexDirection::Row,
    };

    let justify_content = match prop_str(props, "justify_content") {
        Some("flex-start") => Some(JustifyContent::FlexStart),
        Some("flex-end") => Some(JustifyContent::FlexEnd),
        Some("center") => Some(JustifyContent::Center),
        Some("space-between") => Some(JustifyContent::SpaceBetween),
        Some("space-around") => Some(JustifyContent::SpaceAround),
        Some("space-evenly") => Some(JustifyContent::SpaceEvenly),
        _ => None, // taffy default: flex-start on the main axis
    };

    let align_items = match prop_str(props, "align_items") {
        Some("flex-start") => Some(AlignItems::FlexStart),
        Some("flex-end") => Some(AlignItems::FlexEnd),
        Some("center") => Some(AlignItems::Center),
        Some("baseline") => Some(AlignItems::Baseline),
        Some("stretch") => Some(AlignItems::Stretch),
        _ => None, // taffy default: stretch on the cross axis
    };

    // align_content packs whole flex lines on the cross axis. Unset means
    // stretch (taffy's default), which is a no-op with a single line.
    let align_content = match prop_str(props, "align_content") {
        Some("flex-start") => Some(AlignContent::FlexStart),
        Some("flex-end") => Some(AlignContent::FlexEnd),
        Some("center") => Some(AlignContent::Center),
        Some("stretch") => Some(AlignContent::Stretch),
        Some("space-between") => Some(AlignContent::SpaceBetween),
        Some("space-around") => Some(AlignContent::SpaceAround),
        Some("space-evenly") => Some(AlignContent::SpaceEvenly),
        _ => None, // taffy default: stretch
    };

    // Per-axis gaps override the uniform `gap` on their axis. taffy stores
    // gap.width = main-axis gap and gap.height = cross-axis gap, so for a row
    // container column_gap separates items horizontally and row_gap separates
    // lines vertically; for a column container the axes swap.
    let (gap, column_gap, row_gap) = (
        prop_number(props, "gap"),
        prop_number(props, "column_gap"),
        prop_number(props, "row_gap"),
    );

    let position = match prop_str(props, "position") {
        Some("absolute") => Position::Absolute,
        _ => Position::Relative,
    };

    // Inset edges for `position: absolute` (and relative, where they offset
    // the laid-out position). Unset edges stay `Auto`.
    let inset = TaffyRect {
        top: prop_number(props, "top")
            .map(length_auto)
            .unwrap_or(LengthPercentageAuto::Auto),
        right: prop_number(props, "right")
            .map(length_auto)
            .unwrap_or(LengthPercentageAuto::Auto),
        bottom: prop_number(props, "bottom")
            .map(length_auto)
            .unwrap_or(LengthPercentageAuto::Auto),
        left: prop_number(props, "left")
            .map(length_auto)
            .unwrap_or(LengthPercentageAuto::Auto),
    };

    let (padding, border) = (
        prop_number(props, "padding"),
        prop_number(props, "border"),
    );

    // Per-side spacing overrides the per-axis prop, which overrides the
    // uniform prop on that side — the same cascade `gap` /
    // `row_gap` / `column_gap` use, one level deeper. Each side falls back
    // to 0 when nothing is set.
    let (padding_x, padding_y) = (
        prop_number(props, "padding_x"),
        prop_number(props, "padding_y"),
    );
    let (padding_top, padding_right, padding_bottom, padding_left) = (
        prop_number(props, "padding_top"),
        prop_number(props, "padding_right"),
        prop_number(props, "padding_bottom"),
        prop_number(props, "padding_left"),
    );
    let (margin, margin_x, margin_y) = (
        prop_number(props, "margin"),
        prop_number(props, "margin_x"),
        prop_number(props, "margin_y"),
    );
    let (margin_top, margin_right, margin_bottom, margin_left) = (
        prop_number(props, "margin_top"),
        prop_number(props, "margin_right"),
        prop_number(props, "margin_bottom"),
        prop_number(props, "margin_left"),
    );

    // `display` switches the layout algorithm. `"none"` is additionally
    // short-circuited earlier — the engine never builds a `display: none`
    // node into the taffy tree (see `build_node`) — so this mapping is the
    // defensive half of the same rule.
    let display = match prop_str(props, "display") {
        Some("grid") => Display::Grid,
        Some("none") => Display::None,
        _ => Display::Flex, // default
    };

    // Grid template tracks: space-separated `<n>fr` / `<n>px` / `<n>%` /
    // `auto` tokens. Absent or unparseable strings yield an empty template,
    // which taffy resolves as auto-sized implicit tracks (the CSS default).
    let grid_template_columns = parse_grid_tracks(prop_str(props, "grid_template_columns"));
    let grid_template_rows = parse_grid_tracks(prop_str(props, "grid_template_rows"));

    let grid_auto_flow = match prop_str(props, "grid_auto_flow") {
        Some("column") => GridAutoFlow::Column,
        Some("row-dense") => GridAutoFlow::RowDense,
        Some("column-dense") => GridAutoFlow::ColumnDense,
        _ => GridAutoFlow::Row, // default
    };

    // Grid item placement: an integer line index or a `"span N"` string. Sets
    // only the start line; the end stays `Auto`, which the placement
    // algorithm resolves to a one-track span.
    let grid_row = parse_grid_placement(props, "grid_row");
    let grid_column = parse_grid_placement(props, "grid_column");

    TaffyStyle {
        display,
        flex_direction,
        justify_content,
        align_items,
        align_content,
        grid_template_columns,
        grid_template_rows,
        grid_auto_flow,
        grid_row,
        grid_column,
        gap: TaffySize {
            width: column_gap
                .or(gap)
                .map(length)
                .unwrap_or(LengthPercentage::Length(0.0)),
            height: row_gap
                .or(gap)
                .map(length)
                .unwrap_or(LengthPercentage::Length(0.0)),
        },
        padding: TaffyRect {
            top: length(padding_top.or(padding_y).or(padding).unwrap_or(0.0)),
            right: length(padding_right.or(padding_x).or(padding).unwrap_or(0.0)),
            bottom: length(padding_bottom.or(padding_y).or(padding).unwrap_or(0.0)),
            left: length(padding_left.or(padding_x).or(padding).unwrap_or(0.0)),
        },
        border: match border {
            Some(b) => taffy::geometry::Rect {
                left: length(b),
                right: length(b),
                top: length(b),
                bottom: length(b),
            },
            None => taffy::geometry::Rect::zero(),
        },
        // Margin offsets the node's laid-out position within its parent's
        // content box; it does not change the node's own size.
        margin: TaffyRect {
            top: length_auto(margin_top.or(margin_y).or(margin).unwrap_or(0.0)),
            right: length_auto(margin_right.or(margin_x).or(margin).unwrap_or(0.0)),
            bottom: length_auto(margin_bottom.or(margin_y).or(margin).unwrap_or(0.0)),
            left: length_auto(margin_left.or(margin_x).or(margin).unwrap_or(0.0)),
        },
        // Width/height (and the min/max clamps below) accept a number
        // (length in cells) or a `"N%"` string (percent of the containing
        // block's content-box size, via `LengthPercentage::Percent` — taffy
        // stores the fraction, see `prop_length_percentage`).
        size: TaffySize {
            width: prop_length_percentage(props, "width")
                .map(Dimension::from)
                .unwrap_or(Dimension::Auto),
            height: prop_length_percentage(props, "height")
                .map(Dimension::from)
                .unwrap_or(Dimension::Auto),
        },
        min_size: TaffySize {
            width: prop_length_percentage(props, "min_width")
                .map(Dimension::from)
                .unwrap_or(Dimension::Auto),
            height: prop_length_percentage(props, "min_height")
                .map(Dimension::from)
                .unwrap_or(Dimension::Auto),
        },
        max_size: TaffySize {
            width: prop_length_percentage(props, "max_width")
                .map(Dimension::from)
                .unwrap_or(Dimension::Auto),
            height: prop_length_percentage(props, "max_height")
                .map(Dimension::from)
                .unwrap_or(Dimension::Auto),
        },
        // The item's initial main-axis size: taffy's flex algorithm grows or
        // shrinks the item from this basis (the pane-side half of a split
        // resize — `dragPanels` in @tern/core sets it as absolute cells).
        flex_basis: prop_number(props, "flex_basis")
            .map(dimension)
            .unwrap_or(Dimension::Auto),
        position,
        inset,
        ..TaffyStyle::default()
    }
}

/// Read a string property.
pub(super) fn prop_str<'a>(props: &'a PropMap, key: &str) -> Option<&'a str> {
    match props.get(key) {
        Some(PropValue::Str(s)) => Some(s.as_str()),
        _ => None,
    }
}

/// Read an integer or float property as `f32` cells.
fn prop_number(props: &PropMap, key: &str) -> Option<f32> {
    match props.get(key) {
        Some(PropValue::Int(i)) => Some(*i as f32),
        Some(PropValue::Float(f)) => Some(*f as f32),
        _ => None,
    }
}

/// Read a length-or-percentage property: a number is a length in cells, a
/// `"N%"` string is a percentage of the containing block's size.
///
/// Percentage semantics follow taffy 0.7's `LengthPercentage::Percent`, which
/// stores a **0..1 fraction** (50% -> 0.5) — see
/// `taffy-0.7.7/src/style/dimension.rs:23-25` ("percentages are represented as
/// a f32 value in the range [0.0, 1.0] NOT the range [0.0, 100.0]").
///
/// Degradation is predictable and panic-free: a string that does not match
/// `${number}%` (e.g. `"50"`, `"50 %"`, `"abc"`, `""`) yields `None`, so the
/// prop behaves exactly as if it were absent (the engine falls back to
/// `Auto`). A `%` value is never clamped; taffy clamps resulting geometry to
/// non-negative sizes.
pub(super) fn prop_length_percentage(props: &PropMap, key: &str) -> Option<LengthPercentage> {
    match props.get(key) {
        Some(PropValue::Int(i)) => Some(LengthPercentage::Length(*i as f32)),
        Some(PropValue::Float(f)) => Some(LengthPercentage::Length(*f as f32)),
        Some(PropValue::Str(s)) => parse_percent(s).map(LengthPercentage::Percent),
        _ => None,
    }
}

/// Parse a `"N%"` string into a 0..1 fraction (`"50%"` -> `0.5`). Returns
/// `None` for anything that is not a plain decimal number followed by a single
/// trailing `%` (no leading/trailing whitespace, no units). Negative values
/// parse and pass through unchanged — the resulting geometry is clamped to
/// non-negative sizes by taffy.
pub(super) fn parse_percent(s: &str) -> Option<f32> {
    let num = s.strip_suffix('%')?;
    let value: f32 = num.parse().ok()?;
    Some(value / 100.0)
}

/// Parse a grid track template string into taffy track sizing functions.
///
/// The template is a space-separated list of track tokens (the string form
/// the napi binding preserves — arrays/objects are dropped before the props
/// reach the engine):
///
/// - `<n>fr` — a flex fraction: the track shares the container's free space
///   proportionally (`1fr 2fr` splits it 1:2). taffy represents it as
///   `min: auto, max: flex(n)`.
/// - `<n>px` / bare `<n>` — a fixed length in cells.
/// - `<n>%` — a percentage of the container's inner size (stored as a 0..1
///   fraction, matching `LengthPercentage::Percent` semantics).
/// - `auto` — content-sized (taffy's `Auto` sizing function).
///
/// Absent props, empty strings, and unparseable tokens all degrade
/// panic-free: the offending token is skipped, and an empty template is left
/// as-is (taffy resolves no explicit tracks as implicit auto tracks, the CSS
/// default). No clamping is applied — negative or zero flex fractions pass
/// through and taffy's own track sizing clamps geometry to non-negative.
fn parse_grid_tracks(s: Option<&str>) -> Vec<TrackSizingFunction> {
    s.map(|s| s.split_whitespace().filter_map(parse_grid_track).collect())
        .unwrap_or_default()
}

/// Parse a single grid track token (see [`parse_grid_tracks`]); `None` for
/// anything that is not a recognized track form.
fn parse_grid_track(token: &str) -> Option<TrackSizingFunction> {
    let t = token.trim();
    if t == "auto" {
        return Some(TrackSizingFunction::Single(
            NonRepeatedTrackSizingFunction::AUTO,
        ));
    }
    if let Some(num) = t.strip_suffix("fr") {
        return Some(TrackSizingFunction::from_flex(num.trim().parse::<f32>().ok()?));
    }
    if let Some(num) = t.strip_suffix('%') {
        let percent: f32 = num.trim().parse().ok()?;
        return Some(TrackSizingFunction::from_percent(percent / 100.0));
    }
    if let Some(num) = t.strip_suffix("px") {
        return Some(TrackSizingFunction::from_length(num.trim().parse::<f32>().ok()?));
    }
    // Bare number: a fixed length in cells (the JS docs advertise `10px 1fr`
    // and bare `10` as equivalent fixed tracks).
    t.parse::<f32>()
        .ok()
        .map(TrackSizingFunction::from_length)
}

/// Parse a grid item placement prop (`grid_row` / `grid_column`) into a taffy
/// `Line<GridPlacement>`.
///
/// - `Int(n)` — a grid line index: positive counts from the start edge
///   (line 1 is the first), negative from the end edge (line -1 is the last);
///   0 is invalid and degrades to `Auto` (taffy treats it as auto placement).
///   Only the start line is set; the end stays `Auto`, which the placement
///   algorithm resolves to a one-track span.
/// - `Str("span N")` — the item spans `N` tracks. Only the start span is set.
///
/// Absent props and any other value (e.g. a malformed string) yield
/// `Line { Auto, Auto }` — the item is auto-placed by `grid_auto_flow`.
fn parse_grid_placement(props: &PropMap, key: &str) -> TaffyLine<GridPlacement> {
    match props.get(key) {
        Some(PropValue::Int(i)) => {
            let index = (*i).clamp(i16::MIN as i64, i16::MAX as i64) as i16;
            if index == 0 {
                // 0 is not a valid grid line; taffy treats it as Auto.
                TaffyLine { start: GridPlacement::Auto, end: GridPlacement::Auto }
            } else {
                grid_line::<TaffyLine<GridPlacement>>(index)
            }
        }
        Some(PropValue::Str(s)) => {
            let span = s.trim().strip_prefix("span").map(str::trim).and_then(|n| n.parse::<u16>().ok());
            match span {
                Some(n) => grid_span::<TaffyLine<GridPlacement>>(n),
                None => TaffyLine { start: GridPlacement::Auto, end: GridPlacement::Auto },
            }
        }
        _ => TaffyLine { start: GridPlacement::Auto, end: GridPlacement::Auto },
    }
}

/// Read a boolean property.
pub(super) fn prop_bool(props: &PropMap, key: &str) -> Option<bool> {
    match props.get(key) {
        Some(PropValue::Bool(b)) => Some(*b),
        _ => None,
    }
}
