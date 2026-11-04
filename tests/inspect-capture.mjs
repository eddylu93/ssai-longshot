import fs from "node:fs";
import { createRequire } from "node:module";
import { analyzeFramesCV, planSegments } from "../src/stitching.ts";
const { PNG } = createRequire(import.meta.resolve("pixelmatch"))("pngjs");
const [input, frameHeight, output] = process.argv.slice(2);
const image = PNG.sync.read(fs.readFileSync(input));
const h = Number(frameHeight);
if (image.height % h !== 0) throw new Error("Input must contain complete, unmodified frames");
const images = Array.from({ length: image.height / h }, (_, i) => ({ width: image.width, height: h, data: image.data.subarray(i * h * image.width * 4, (i + 1) * h * image.width * 4) }));
const result = await analyzeFramesCV(images);
console.log(JSON.stringify({ width: image.width, frameHeight: h, frames: images.length, ...result }, null, 2));
if (output && result.matches.every((m) => m.confidence > 0)) {
  const segments = planSegments(images.map((image) => image.height), result.matches.map((m) => m.pixels), result.edges);
  const png = new PNG({ width: images[0].width, height: segments.reduce((sum, s) => sum + s.height, 0) });
  segments.forEach((s, i) => png.data.set(images[i].data.subarray(s.crop * png.width * 4, (s.crop + s.height) * png.width * 4), s.y * png.width * 4));
  fs.writeFileSync(output, PNG.sync.write(png));
}
