import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const folder = new URL("../output/playwright/", import.meta.url);
mkdirSync(folder, { recursive: true });
function crc32(data) {
  let crc = -1;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name);
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([size, type, data, crc]);
}
function png(width, height, offset, filename) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = y * (width * 4 + 1) + 1 + x * 4;
    let seed = Math.imul(y + offset + 1, 2654435761) ^ Math.imul(Math.floor(x / 8) + 1, 1597334677);
    seed ^= seed >>> 16;
    raw[i] = (seed >>> 16) & 255;
    raw[i + 1] = (seed >>> 8) & 255;
    raw[i + 2] = seed & 255;
    raw[i + 3] = 255;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  writeFileSync(new URL(filename, folder), Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
png(320, 520, 0, "overlap-a.png");
png(320, 520, 359, "overlap-b.png");
png(1080, 12000, 0, "long.png");
png(320, 879, 0, "expected.png");
png(320, 520, 1800, "unrelated.png");
