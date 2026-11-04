# Upstream

- Source: https://github.com/jswysnemc/wayscrollshot
- Revision: `703474ad7b94a504306d7a93d21668ee162ebf1c`
- Imported directory: `src/stitch/band`, including upstream tests.
- License: MIT, retained in LICENSE and application notices.
- Local adapter: minimal Cargo/lib wrapper and public aliases for the raw engine.
- Local safety changes: output allocation capped at 32 million pixels and
  effective height at 32760 rows, checked before using reserved capacity.
- Local verification: original RGB overlap comparison before placement commit;
  fixed bars and stationary sidebar bands are excluded, one animated outlier band
  is tolerated. At least two bands must verify. Signature equality alone no longer
  qualifies a frame as identical. Added a signature-collision regression test.
- Local recovery: restore motion/fixed-region detector state on NoMatch as well
  as allocation errors, so rejected frames cannot contaminate the next match.
- Local ambiguity guard: reject growth when another reachable position has a
  comparable signature score and also passes original RGB verification. Perfectly
  identical viewports remain fundamentally indistinguishable from no movement.
- `examples/replay.rs` is a local offline fixture replay utility, not upstream UI.
- Local image-case fixes: nonzero approximate scores cannot terminate adjacent
  search before candidate refinement. Equal adjacent scores are ranked against
  the existing canvas, and contradictory cropped zero scores trigger complete
  offset refinement. Only zero scores on both references remain a fast path.
- Rejected frames mark recovery mode. Recovery and stationary-placement checks
  require original RGB agreement within three channel levels, allowing at most
  one bounded 24x24 patch instead of broad band averages that can hide changed captions.
- Alternative positions must also pass the strict pixel check before they can
  cause ambiguity rejection. Known-canvas search prefers lower error over proximity.
- `examples/image_matrix.rs` and application `examples/image_adapter_audit.rs`
  are local diagnostics; system wallpaper assets are not application resources.
- No Wayland, shell capture, OpenCV or desktop UI code is included.
