// Run explicitly with a synthetic Vision OCR result and its RGBA pixels.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detectChatLayout } from "../src/privacy-cv.ts";
import { privacyBoxes } from "../src/privacy.ts";

const [stem, zoom = "1"] = process.argv.slice(2);
if (!stem) throw new Error("Usage: node tests/native-privacy.audit.mjs output/privacy-polish/group-light [scale]");
const scale = Number(zoom), width = 900 * scale, height = 1800 * scale;
const lines = JSON.parse(readFileSync(`${stem}.ocr.json`, "utf8"));
const data = new Uint8ClampedArray(readFileSync(`${stem}.rgba`));
assert.equal(data.length, width * height * 4);
const layout = await detectChatLayout({ width, height, data }, lines);
const boxes = privacyBoxes(lines, layout.avatars, { time: true, names: true, avatars: true }, width, height, layout.bubbles);
const report = { avatars: layout.avatars, bubbles: layout.bubbles, masks: boxes };
console.log(JSON.stringify(report, null, 2));
const covered = (line, category) => boxes.some((b) => b.category === category && b.x <= line.x && b.y <= line.y && b.x + b.width >= line.x + line.width && b.y + b.height >= line.y + line.height);
for (const top of [140, 340, 620, 850, 1080, 1330]) {
  const sender = lines.filter((line) => Math.abs(line.y - top * scale) < 12 * scale && line.x > 80 * scale && line.x < 820 * scale);
  assert.ok(sender.length, `Vision missed sender at ${top}`);
  assert.ok(sender.every((line) => covered(line, "names")), `sender not fully covered at ${top}`);
}
for (const top of [195, 225, 906, 1134, 1638, 1671]) {
  const body = lines.find((line) => Math.abs(line.y - top * scale) < 12 * scale && line.x > 80 * scale && line.text.length > 5);
  assert.ok(body, `Vision missed body at ${top}`);
  assert.ok(!boxes.some((b) => b.category === "names" && b.x < body.x + body.width && b.x + b.width > body.x && b.y < body.y + body.height && b.y + b.height > body.y), `body incorrectly masked at ${top}`);
}
assert.equal(boxes.filter((b) => b.category === "names").length, 6);
assert.equal(boxes.filter((b) => b.category === "time").length, 1);
assert.equal(boxes.filter((b) => b.category === "avatars").length, 7);
console.log("Synthetic Vision + OpenCV audit passed: 6 sender labels, 7 avatars, 1 timestamp, 6 body lines preserved.");
