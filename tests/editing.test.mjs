import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedCrop, imagePoint, watermarkPlacement, watermarkTiles } from "../src/editing.ts";

test("editing coordinates use current canvas bounds after a dock opens, closes or moves", () => {
  const image = { width: 900, height: 1800 }, expected = { x: 180, y: 720 };
  for (const bounds of [{ left: 16, top: 72, width: 408, height: 816 }, { left: 24, top: 72, width: 600, height: 1200 }, { left: 90, top: -240, width: 900, height: 1800 }]) {
    const actual = imagePoint({ x: bounds.left + bounds.width * .2, y: bounds.top + bounds.height * .4 }, bounds, image);
    assert.ok(Math.abs(actual.x - expected.x) < 1e-6);
    assert.ok(Math.abs(actual.y - expected.y) < 1e-6);
  }
});

test("drawing on a cropped view maps back into original-image coordinates", () => {
  const crop = { x: 120, y: 340, width: 600, height: 800 };
  const local = imagePoint({ x: 210, y: 280 }, { left: 60, top: 80, width: 300, height: 400 }, crop);
  assert.deepEqual({ x: local.x + crop.x, y: local.y + crop.y }, { x: 420, y: 740 });
});

test("crop stays within the current crop in original-image coordinates", () => {
  const bounds = { x: 100, y: 200, width: 300, height: 500 };
  assert.deepEqual(boundedCrop({ x: 80, y: 250, width: 600, height: 900 }, bounds), { x: 100, y: 250, width: 300, height: 450 });
  assert.deepEqual(boundedCrop({ x: 120.4, y: 220.6, width: 50.1, height: 70.2 }, bounds), { x: 120, y: 221, width: 51, height: 70 });
});
test("out-of-bounds selections cannot create empty or negative canvases", () => {
  assert.deepEqual(boundedCrop({ x: 999, y: 999, width: 1, height: 1 }, { x: 0, y: 0, width: 100, height: 80 }), { x: 99, y: 79, width: 1, height: 1 });
});
test("fixed watermark placement is based on final output dimensions", () => {
  const canvas = { width: 300, height: 500 }, box = { width: 80, height: 40 };
  assert.deepEqual(watermarkPlacement(canvas, box, "top-left", { x: 1, y: 1 }), { x: 30, y: 30 });
  assert.deepEqual(watermarkPlacement(canvas, box, "bottom-right", { x: 0, y: 0 }), { x: 190, y: 430 });
  assert.deepEqual(watermarkPlacement(canvas, box, "center", { x: 0, y: 0 }), { x: 110, y: 230 });
});
test("random placement remains deterministic across preview, resize and export", () => {
  const canvas = { width: 300, height: 500 }, box = { width: 80, height: 40 }, point = { x: .27, y: .81 };
  const first = watermarkPlacement(canvas, box, "random", point);
  for (let i = 0; i < 20; i++) assert.deepEqual(watermarkPlacement(canvas, box, "random", point), first);
  assert.ok(first.x >= 30 && first.x <= 190 && first.y >= 30 && first.y <= 430);
});

test("full-image watermark tiles are deterministic, distributed and reshufflable", () => {
  const canvas = { width: 900, height: 12000 }, box = { width: 200, height: 32 }, seed = { x: .27, y: .81 };
  const tiles = watermarkTiles(canvas, box, "balanced", seed);
  assert.deepEqual(watermarkTiles(canvas, box, "balanced", seed), tiles);
  assert.notDeepEqual(watermarkTiles(canvas, box, "balanced", { x: .4, y: .2 }), tiles);
  assert.ok(tiles.length > 30 && tiles.length <= 2000);
  for (let band = 0; band < 20; band++) assert.ok(tiles.some((tile) => Math.floor(tile.y / 600) === band));
  const rowY = tiles[0].y;
  assert.ok(tiles.some((tile) => tile.x < 450 && tile.y < rowY + 150));
  assert.ok(tiles.some((tile) => tile.x > 450 && tile.y < rowY + 150));
  assert.ok(watermarkTiles(canvas, box, "dense", seed).length > tiles.length);
  assert.ok(watermarkTiles(canvas, box, "sparse", seed).length < tiles.length);
});

test("rotated watermark bounds fit short, narrow and cropped output sizes", () => {
  for (const canvas of [{ width: 20, height: 20 }, { width: 40, height: 1200 }, { width: 1800, height: 25 }, { width: 900, height: 12000 }]) {
    const box = { width: 220, height: 80 };
    for (const density of ["sparse", "balanced", "dense"]) for (const seed of [{ x: 0, y: 0 }, { x: 1, y: 1 }]) {
      const tiles = watermarkTiles(canvas, box, density, seed);
      assert.ok(tiles.length);
      for (const tile of tiles) {
        const halfW = (box.width * Math.cos(tile.angle) + box.height * Math.abs(Math.sin(tile.angle))) * tile.scale / 2;
        const halfH = (box.width * Math.abs(Math.sin(tile.angle)) + box.height * Math.cos(tile.angle)) * tile.scale / 2;
        assert.ok(tile.x >= halfW && tile.x + halfW <= canvas.width);
        assert.ok(tile.y >= halfH && tile.y + halfH <= canvas.height);
      }
    }
  }
});

test("maximum image and tiny labels cannot produce unbounded draw calls", () => {
  const tiles = watermarkTiles({ width: 32000, height: 1000 }, { width: .2, height: .2 }, "dense", { x: .5, y: .5 });
  assert.ok(tiles.length > 0 && tiles.length <= 2000);
  for (const width of [0, -1, NaN, Infinity]) assert.deepEqual(watermarkTiles({ width, height: 100 }, { width: 30, height: 10 }, "dense", { x: 0, y: 0 }), []);
});
