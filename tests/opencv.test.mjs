import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeFramesCV, orderCapturedFramesCV, planSegments } from "../src/stitching.ts";

function frame(offset, { sidebar = false, sticky = false, repeated = false } = {}) {
  const width = 240, height = 400;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const row = repeated ? (y + offset) % 60 : y + offset;
    let v = Math.imul(row + 1, 2654435761) ^ Math.imul(x + 1, 1597334677); v ^= v >>> 16;
    if (sidebar && (x < 48 || x > 210)) v = Math.imul(y + x, 829467);
    if (sticky && y < 32) v ^= Math.imul(y + offset, 739);
    data[i] = v >>> 16 & 255; data[i + 1] = v >>> 8 & 255; data[i + 2] = v & 255;
  }
  return { width, height, data };
}

test("OpenCV finds exact translation with stationary sidebars", async () => {
  const result = await analyzeFramesCV([frame(0, { sidebar: true }), frame(137, { sidebar: true }), frame(283, { sidebar: true })]);
  assert.deepEqual(result.matches.map(m => m.pixels), [263, 254]);
  assert.ok(result.matches.every(m => m.confidence === 1));
});
test("OpenCV refuses unrelated frames instead of inventing a seam", async () => {
  const { matches } = await analyzeFramesCV([frame(0), frame(500)]);
  assert.equal(matches[0].confidence, 0);
});
test("OpenCV refuses ambiguous repeated content", async () => {
  const { matches } = await analyzeFramesCV([frame(0, { repeated: true }), frame(17, { repeated: true })]);
  assert.equal(matches[0].confidence, 0);
});
test("OpenCV does not require a large overlap", async () => {
  const { matches } = await analyzeFramesCV([frame(0), frame(365)]);
  assert.equal(matches[0].pixels, 35);
});
test("OpenCV stitches without resampling source pixels", async () => {
  const a = frame(0), b = frame(137), { edges, matches } = await analyzeFramesCV([a, b]);
  const segments = planSegments([400, 400], matches.map(m => m.pixels), edges);
  assert.equal(segments.reduce((n, s) => n + s.height, 0), 537);
  assert.equal(segments[1].crop, 263);
});
test("OpenCV can exclude a changing sticky header after verifying body", async () => {
  const { edges, matches } = await analyzeFramesCV([frame(0, { sticky: true }), frame(137, { sticky: true })]);
  assert.equal(edges.top, 32);
  assert.equal(matches[0].pixels, 231);
});

test("upward capture is sorted by content instead of acquisition time", async () => {
  const images = [frame(300), frame(170), frame(0)];
  const order = await orderCapturedFramesCV(images, ["a", "a", "a"]);
  assert.deepEqual(order, [2, 1, 0]);
  const { matches } = await analyzeFramesCV(order.map(i => images[i]));
  assert.deepEqual(matches.map(m => m.pixels), [230, 270]);
});
test("downward capture keeps order", async () => {
  assert.deepEqual(await orderCapturedFramesCV([frame(0), frame(170), frame(300)], ["a", "a", "a"]), [0, 1, 2]);
});
test("direction reversals remove revisited viewports and preserve all new rows", async () => {
  const offsets = [200, 330, 200, 80, 0, 170];
  const images = offsets.map(offset => frame(offset));
  const order = await orderCapturedFramesCV(images, offsets.map(() => "a"));
  assert.deepEqual(order.map(i => offsets[i]), [0, 80, 170, 200, 330]);
  const { matches, edges } = await analyzeFramesCV(order.map(i => images[i]));
  assert.ok(matches.every(m => m.confidence));
  const segments = planSegments(order.map(() => 400), matches.map(m => m.pixels), edges);
  assert.equal(segments.reduce((n, s) => n + s.height, 0), 730);
  for (let i = 0; i < order.length; i++) {
    const segment = segments[i], source = images[order[i]];
    for (let row = 0; row < segment.height; row++) {
      assert.equal(offsets[order[i]] + segment.crop + row, segment.y + row);
      assert.equal(source.data[((segment.crop + row) * 240) * 4], framePixel(segment.y + row));
    }
  }
});
function framePixel(row) {
  let v = Math.imul(row + 1, 2654435761) ^ Math.imul(1, 1597334677); v ^= v >>> 16;
  return v >>> 16 & 255;
}
test("upward capture supports stationary sidebars and changing headers", async () => {
  for (const options of [{ sidebar: true }, { sticky: true }]) {
    assert.deepEqual(await orderCapturedFramesCV([frame(280, options), frame(137, options), frame(0, options)], ["a", "a", "a"]), [2, 1, 0]);
  }
});
test("stationary duplicates do not add rows", async () => {
  assert.deepEqual(await orderCapturedFramesCV([frame(0), frame(0), frame(100)], ["a", "a", "a"]), [0, 2]);
});
test("a tiny stationary cursor patch keeps the latest viewport instead of breaking auto stitch", async () => {
  const a = frame(0), b = frame(0);
  for (let y = 150; y < 166; y++) for (let x = 100; x < 116; x++) {
    const i = (y * b.width + x) * 4; b.data[i] = 255; b.data[i + 1] = 0;
  }
  assert.deepEqual(await orderCapturedFramesCV([a, b, frame(100)], ["a", "a", "a"]), [1, 2]);
});
test("large stationary changes and bottom-edge new content are not silently discarded", async () => {
  for (const rect of [{ x: 80, y: 150, width: 30, height: 30 }, { x: 80, y: 390, width: 12, height: 10 }]) {
    const a = frame(0), b = frame(0);
    for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) b.data[(y * b.width + x) * 4] ^= 255;
    await assert.rejects(orderCapturedFramesCV([a, b], ["a", "a"]), /无法可靠判断/);
  }
});
test("unrelated and ambiguous captures fail safely without inventing direction", async () => {
  await assert.rejects(orderCapturedFramesCV([frame(0), frame(500)], ["a", "a"]), /无法可靠判断/);
  await assert.rejects(orderCapturedFramesCV([frame(0, { repeated: true }), frame(17, { repeated: true })], ["a", "a"]), /无法可靠判断/);
});
test("imports and separate capture sessions are never globally rearranged", async () => {
  assert.deepEqual(await orderCapturedFramesCV([frame(500), frame(0), frame(200), frame(100)], [null, null, "b", "b"]), [0, 1, 3, 2]);
});
