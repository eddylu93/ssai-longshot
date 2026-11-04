import { test } from "node:test";
import assert from "node:assert/strict";
import { fitTransform, constrainTransform, zoomAt, exportDecision } from "../src/viewer.ts";

test("long preview fits width, starts at top and remains horizontally centered", () => {
  const image = { width: 571, height: 2240 }, viewport = { width: 440, height: 560 };
  const t = fitTransform(image, viewport);
  assert.equal(t.x, 12);
  assert.equal(t.y, 12);
  assert.equal(t.scale, 416 / 571);
});
test("small image is centered in both axes without upscaling", () => {
  assert.deepEqual(fitTransform({ width: 200, height: 100 }, { width: 440, height: 560 }), { x: 120, y: 230, scale: 1 });
});
test("wheel zoom anchors the pixel beneath the mouse while panning stays in bounds", () => {
  const image = { width: 2000, height: 4000 }, viewport = { width: 600, height: 600 };
  const before = { x: -200, y: -300, scale: 1 }, p = { x: 200, y: 240 };
  const after = zoomAt(before, p, -120, image, viewport);
  assert.ok(after.scale > before.scale);
  assert.ok(Math.abs((p.x - before.x) / before.scale - (p.x - after.x) / after.scale) < 0.000001);
  assert.ok(Math.abs((p.y - before.y) / before.scale - (p.y - after.y) / after.scale) < 0.000001);
});
test("resize constrains pan without changing image scale", () => {
  const t = constrainTransform({ x: -5000, y: 2000, scale: 2 }, { width: 1000, height: 4000 }, { width: 360, height: 420 });
  assert.deepEqual(t, { x: -1664, y: 24, scale: 2 });
});
test("repeated wheel gestures cannot produce invalid or unbounded scale", () => {
  const image = { width: 1000, height: 12000 }, viewport = { width: 360, height: 420 };
  let t = fitTransform(image, viewport);
  for (let i = 0; i < 100; i++) t = zoomAt(t, { x: 180, y: 210 }, -500, image, viewport);
  assert.equal(t.scale, 4);
  for (let i = 0; i < 100; i++) t = zoomAt(t, { x: 180, y: 210 }, 500, image, viewport);
  assert.ok(t.scale > 0 && t.scale <= 0.08);
  assert.ok(Object.values(t).every(Number.isFinite));
});
test("uncertain seams request explicit confirmation instead of disabling export", () => {
  assert.equal(exportDecision(true, false, false, 2), "confirm");
  assert.equal(exportDecision(true, false, false, 0), "ready");
});
test("busy, missing result and stale seams still block unsafe export", () => {
  assert.equal(exportDecision(false, false, false, 0), "blocked");
  assert.equal(exportDecision(true, true, false, 2), "blocked");
  assert.equal(exportDecision(true, false, true, 0), "blocked");
});
