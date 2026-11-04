export type Rect = { x: number; y: number; width: number; height: number };
export type Position = "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center" | "random";
export type RandomPoint = { x: number; y: number };
export type WatermarkMode = "single" | "tiled";
export type WatermarkDensity = "sparse" | "balanced" | "dense";
export type WatermarkLayout = { mode: WatermarkMode; density: WatermarkDensity; random: RandomPoint };

export function imagePoint(pointer: { x: number; y: number }, bounds: { left: number; top: number; width: number; height: number }, image: { width: number; height: number }) {
  return { x: (pointer.x - bounds.left) / bounds.width * image.width, y: (pointer.y - bounds.top) / bounds.height * image.height };
}

export function boundedCrop(selection: Rect, bounds: Rect): Rect {
  const x = Math.max(bounds.x, Math.min(bounds.x + bounds.width - 1, Math.round(selection.x)));
  const y = Math.max(bounds.y, Math.min(bounds.y + bounds.height - 1, Math.round(selection.y)));
  const right = Math.max(x + 1, Math.min(bounds.x + bounds.width, Math.round(selection.x + selection.width)));
  const bottom = Math.max(y + 1, Math.min(bounds.y + bounds.height, Math.round(selection.y + selection.height)));
  return { x, y, width: right - x, height: bottom - y };
}

export function watermarkPlacement(canvas: { width: number; height: number }, box: { width: number; height: number }, position: Position, random: RandomPoint) {
  const padding = Math.min(36, canvas.width / 10, canvas.height / 10);
  const availableX = Math.max(0, canvas.width - box.width - padding * 2);
  const availableY = Math.max(0, canvas.height - box.height - padding * 2);
  const factor = (axis: "x" | "y") => position === "random" ? Math.max(0, Math.min(1, random[axis]))
    : position === "center" ? 0.5 : axis === "x" ? Number(position.includes("right")) : Number(position.includes("bottom"));
  return { x: padding + availableX * factor("x"), y: padding + availableY * factor("y") };
}

export function watermarkTiles(canvas: { width: number; height: number }, box: { width: number; height: number }, density: WatermarkDensity, seed: RandomPoint) {
  if (![canvas.width, canvas.height, box.width, box.height].every((n) => Number.isFinite(n) && n > 0)) return [];
  const angle = -Math.PI / 8;
  const rotatedWidth = box.width * Math.cos(angle) + box.height * Math.abs(Math.sin(angle));
  const rotatedHeight = box.width * Math.abs(Math.sin(angle)) + box.height * Math.cos(angle);
  const scale = Math.min(1, canvas.width * .9 / rotatedWidth, canvas.height * .9 / rotatedHeight);
  const width = rotatedWidth * scale, height = rotatedHeight * scale;
  const gap = { sparse: 2.5, balanced: 1.8, dense: 1.25 }[density];
  let columns = Math.max(1, Math.floor(canvas.width / (width * gap)));
  let rows = Math.max(1, Math.floor(canvas.height / (height * gap)));
  // Bound drawing work on maximum-size long images, even with very short labels.
  if (columns * rows > 2000) {
    columns = Math.max(1, Math.floor(columns * Math.sqrt(2000 / (columns * rows))));
    rows = Math.max(1, Math.floor(2000 / columns));
  }
  const cellWidth = canvas.width / columns, cellHeight = canvas.height / rows;
  const jitterX = Math.min(cellWidth * .16, (cellWidth - width) * .4);
  const jitterY = Math.min(cellHeight * .16, (cellHeight - height) * .4);
  const random = (index: number, axis: number) => {
    let value = (Math.floor(seed.x * 0xffffffff) ^ Math.imul(Math.floor(seed.y * 0xffffffff), 31) ^ Math.imul(index + 1, 0x9e3779b1) ^ axis) >>> 0;
    value = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
    value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
    return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff - .5;
  };
  return Array.from({ length: columns * rows }, (_, index) => ({
    x: (index % columns + .5) * cellWidth + random(index, 17) * jitterX * 2,
    y: (Math.floor(index / columns) + .5) * cellHeight + random(index, 53) * jitterY * 2,
    angle, scale
  }));
}
