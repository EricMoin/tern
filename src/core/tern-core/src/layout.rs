//! The layout engine contract implemented by tern-layout.
//!
//! # Layout prop vocabulary
//!
//! The engine reads layout keywords from each scene node's `props` map. The
//! full vocabulary an engine must understand:
//!
//! | prop | values | default |
//! |------|--------|---------|
//! | `display` | `"flex"` \| `"none"` | `"flex"` |
//! | `flex_direction` | `"row"` \| `"column"` \| `"row-reverse"` \| `"column-reverse"` | `"row"` |
//! | `justify_content` | `"flex-start"` \| `"flex-end"` \| `"center"` \| `"space-between"` \| `"space-around"` \| `"space-evenly"` | unset |
//! | `align_items` | `"flex-start"` \| `"flex-end"` \| `"center"` \| `"stretch"` \| `"baseline"` | unset (stretch) |
//! | `align_content` | `"flex-start"` \| `"flex-end"` \| `"center"` \| `"stretch"` \| `"space-between"` \| `"space-around"` \| `"space-evenly"` | unset (stretch) |
//! | `gap` | cells, uniform on both axes | 0 |
//! | `row_gap` / `column_gap` | cells; per-axis override of `gap` | `gap` / 0 |
//! | `padding` | cells (uniform) | 0 |
//! | `border` | cells (uniform) | 0 |
//! | `width` / `height` | cells | auto |
//! | `min_width` / `min_height` | cells | auto |
//! | `max_width` / `max_height` | cells | auto |
//! | `position` | `"relative"` \| `"absolute"` | `"relative"` |
//! | `top` / `right` / `bottom` / `left` | cells (inset edges; meaningful for `position: absolute`) | auto |
//! | `text` | string content of a `Text` leaf | — |
//! | `z_index` | integer paint order — consumed by the **compositor** (paint order), not by the engine (geometry only) | 0 |
//!
//! `position: absolute` removes the node from flex flow (it occupies no space
//! and does not push siblings); its `top`/`right`/`bottom`/`left` insets
//! resolve against the node's direct parent's padding box. `z_index` does not
//! affect geometry: the engine's output is a plain list of rects, and paint
//! stacking is the compositor's job.

use crate::rect::{Rect, Size};
use crate::scene::{NodeId, Scene};

/// A layout engine computes concrete geometry for every node in a scene tree
/// given a viewport size.
///
/// The result maps each laid-out node (including the root) to the [`Rect`] it
/// occupies in viewport (scene) coordinates. Nodes without geometry — e.g.
/// `display: none` leaves — are simply absent from the result.
pub trait LayoutEngine {
    /// Compute the layout of `root` for a `viewport` sized in cells.
    ///
    /// `root` owns the whole tree (its implicit root node plus descendants);
    /// the engine may traverse it via [`Scene::node`] and [`Scene::children`].
    fn compute(&mut self, root: &Scene, viewport: Size) -> Vec<(NodeId, Rect)>;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A trivial engine used to pin the trait's contract.
    struct Fixed(Vec<(NodeId, Rect)>);

    impl LayoutEngine for Fixed {
        fn compute(&mut self, _root: &Scene, _viewport: Size) -> Vec<(NodeId, Rect)> {
            self.0.clone()
        }
    }

    #[test]
    fn layout_engine_trait_roundtrip() {
        let scene = Scene::new();
        let mut engine = Fixed(vec![(scene.root_id(), Rect::new(0, 0, 80, 24))]);
        let out = engine.compute(&scene, Size::new(80, 24));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, scene.root_id());
        assert_eq!(out[0].1, Rect::new(0, 0, 80, 24));
    }
}
