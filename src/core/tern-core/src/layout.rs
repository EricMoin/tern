//! The layout engine contract implemented by tern-layout.

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
