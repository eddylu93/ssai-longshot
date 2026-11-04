import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeFrames, detectOverlapData, verifyOverlap, planSegments, interpolateStroke } from "../src/stitching.ts";

const width = 96;
const height = 1080;
let seed = 123;
const page = new Uint8ClampedArray(width * height * 3 * 4);
for (let i = 0; i < page.length; i += 1) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  page[i] = seed >>> 24;
}
const frame = (offset) => ({ width, height, data: page.slice(offset * width * 4, (offset + height) * width * 4) });

for (const overlap of [32, 160, 161, 800, 1079, 1080]) {
  test(`detect exact ${overlap}px overlap including duplicate frames`, () => {
    assert.equal(detectOverlapData(frame(0), frame(height - overlap)).pixels, overlap);
  });
}
test("unrelated images keep all content", () => {
  assert.equal(detectOverlapData(frame(0), frame(height)).pixels, 0);
});
test("identical repeated chat patterns are deduplicated", () => {
  const make = (offset) => ({ width, height, data: Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) => (Math.floor(i / (width * 4)) + offset) % 120) });
  assert.equal(detectOverlapData(make(0), make(360)).pixels, height);
});
test("ambiguous repeated patterns keep all content for manual adjustment", () => {
  const make = (offset) => ({ width, height: 520, data: Uint8ClampedArray.from({ length: width * 520 * 4 }, (_, i) => (Math.floor(i / (width * 4)) + offset) % 120) });
  assert.equal(detectOverlapData(make(0), make(80)).pixels, 0);
});
test("slight compression noise does not prevent overlap matching", () => {
  const b = frame(height - 161);
  for (let i = 0; i < b.data.length; i += 1) if (i % 4 !== 3) b.data[i] = Math.min(255, b.data[i] + 1);
  assert.equal(detectOverlapData(frame(0), b).pixels, 161);
});
test("nearly blank long images are not cropped based on empty margins", () => {
  const a = { width: 32, height: 12000, data: new Uint8ClampedArray(32 * 12000 * 4).fill(255) };
  const b = { ...a, data: a.data.slice() };
  b.data[0] = 0;
  assert.equal(detectOverlapData(a, b).pixels, 0);
});
test("cropped frames append at the end without overwrites or bottom gaps", () => {
  assert.deepEqual(planSegments([520, 520, 520], [160, 161]), [
    { crop: 0, y: 0, height: 520 },
    { crop: 160, y: 520, height: 360 },
    { crop: 161, y: 880, height: 359 }
  ]);
});
test("identical frame contributes no pixels", () => {
  assert.deepEqual(planSegments([1080, 1080], [1080])[1], { crop: 1080, y: 1080, height: 0 });
});
test("a changed pixel is not silently treated as an exact duplicate", () => {
  const a = frame(0);
  const b = frame(0);
  b.data[0] ^= 255;
  assert.notEqual(detectOverlapData(a, b).confidence, 1);
});
test("fast brush movement covers the entire path", () => {
  const points = interpolateStroke([{ x: 0, y: 0 }, { x: 300, y: 0 }], 12);
  assert.equal(points.at(-1).x, 300);
  assert.ok(points.every((p, i) => i === 0 || p.x - points[i - 1].x <= 4));
});
test("single brush click is retained", () => {
  assert.deepEqual(interpolateStroke([{ x: 3, y: 4 }], 40), [{ x: 3, y: 4 }]);
});

test("full verification catches a changed block between old sampling columns", () => {
  const a = frame(0), b = frame(height - 161);
  for (let y = 9; y < 110; y += 1) for (let x = 1; x < 3; x += 1) {
    const i = (y * width + x) * 4;
    b.data[i] = 255 - b.data[i]; b.data[i + 1] = 255 - b.data[i + 1]; b.data[i + 3] = 255;
  }
  assert.equal(verifyOverlap(a, b, 161), false);
  assert.equal(detectOverlapData(a, b).pixels, 0);
});
test("a small hover patch away from the seam does not hide the correct offset", () => {
  const a = frame(0), b = frame(height - 800);
  for (let y = 180; y < 188; y += 1) for (let x = 10; x < 18; x += 1) {
    const i = (y * width + x) * 4;
    b.data[i] ^= 255; b.data[i + 1] ^= 255; b.data[i + 3] = 255;
  }
  assert.equal(verifyOverlap(a, b, 800), true);
  assert.equal(detectOverlapData(a, b).pixels, 800);
});
test("a changed glyph at the actual cut is rejected", () => {
  const a = frame(0), b = frame(height - 161);
  for (let y = 150; y < 160; y += 1) for (let x = 10; x < 18; x += 1) b.data[(y * width + x) * 4] ^= 255;
  assert.equal(verifyOverlap(a, b, 161), false);
});

test("different width screenshots are rejected, never stretched", () => {
  assert.throws(() => analyzeFrames([frame(0), { ...frame(359), width: width + 1 }]), /宽度不同/);
});
test("subtle compositor noise is deduplicated without masking a changed glyph", () => {
  const a = frame(0), b = frame(0);
  for (let i = 0; i < b.data.length; i += 1) b.data[i] = Math.min(255, b.data[i] + 2);
  assert.equal(detectOverlapData(a, b).pixels, height);
  for (let y = 50; y < 54; y += 1) for (let x = 10; x < 14; x += 1) b.data[(y * width + x) * 4] ^= 255;
  assert.notEqual(detectOverlapData(a, b).pixels, height);
});

test("fixed header and footer are retained once, scroll content aligns pixel for pixel", () => {
  const w = 96, h = 400, top = 24, bottom = 32, contentH = h - top - bottom;
  const body = (offset) => {
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      if (y < top) { data[i] = 20; data[i + 1] = 80; }
      else if (y >= h - bottom) { data[i] = 80; data[i + 2] = 20; }
      else {
        let value = Math.imul(y - top + offset + 1, 2654435761) ^ Math.imul(x + 1, 1597334677);
        value ^= value >>> 16;
        data[i] = value >>> 16 & 255; data[i + 1] = value >>> 8 & 255; data[i + 2] = value & 255;
      }
    }
    return { width: w, height: h, data };
  };
  const images = [body(0), body(160), body(321)];
  const { edges, matches } = analyzeFrames(images);
  assert.deepEqual(edges, { top, bottom });
  assert.deepEqual(matches.map((m) => m.pixels), [contentH - 160, contentH - 161]);
  const segments = planSegments(images.map((i) => i.height), matches.map((m) => m.pixels), edges);
  const output = new Uint8ClampedArray(segments.reduce((sum, s) => sum + s.height, 0) * w * 4);
  segments.forEach((s, i) => output.set(images[i].data.subarray(s.crop * w * 4, (s.crop + s.height) * w * 4), s.y * w * 4));
  assert.equal(output.length / (w * 4), top + contentH + 321 + bottom);
  assert.deepEqual(output.subarray(0, top * w * 4), images[0].data.subarray(0, top * w * 4));
  assert.deepEqual(output.subarray((top + 321) * w * 4), images[2].data.subarray(top * w * 4));
});

test("unverified scrolling keeps fixed chrome intact rather than deleting content", () => {
  const a = frame(0), b = frame(height);
  const stride = a.width * 4;
  b.data.set(a.data.subarray(0, stride * 40));
  const result = analyzeFrames([a, b]);
  assert.deepEqual(result.edges, { top: 0, bottom: 0 });
  assert.equal(result.matches[0].confidence, 0);
});
