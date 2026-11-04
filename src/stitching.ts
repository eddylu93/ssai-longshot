import pixelmatch from "pixelmatch";

export type Pixels = { width: number; height: number; data: ArrayLike<number> };
export type Match = { pixels: number; confidence: number };

function bytes(image: Pixels) {
  return image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray
    ? image.data : Uint8ClampedArray.from(image.data);
}

export function samePixels(a: Pixels, b: Pixels) {
  if (a.width !== b.width || a.height !== b.height) return false;
  for (let i = 0; i < a.data.length; i += 1) if (a.data[i] !== b.data[i]) return false;
  return true;
}

function sameFrame(a: Pixels, b: Pixels) {
  if (a.width !== b.width || a.height !== b.height) return false;
  for (let i = 0; i < a.data.length; i += 1) if (Math.abs(a.data[i] - b.data[i]) > 3) return false;
  return true;
}

function coarseDifference(a: Pixels, b: Pixels, overlap: number) {
  let sum = 0;
  const rows = Math.min(16, overlap);
  for (let row = 0; row < rows; row += 1) {
    const y = Math.floor((row + 0.5) * overlap / rows);
    for (let col = 0; col < 32; col += 1) {
      const x = Math.min(a.width - 1, Math.floor((col + 0.5) * a.width / 32));
      const ai = ((a.height - overlap + y) * a.width + x) * 4;
      const bi = (y * b.width + x) * 4;
      for (let c = 0; c < 3; c += 1) sum += Math.abs(a.data[ai + c] - b.data[bi + c]);
    }
  }
  return sum / (rows * 32 * 3);
}

// Check all pixels; permit at most two small transient patches away from the cut.
export function verifyOverlap(a: Pixels, b: Pixels, overlap: number) {
  if (a.width !== b.width || overlap < 1 || overlap > Math.min(a.height, b.height)) return false;
  const aa = bytes(a), bb = bytes(b), stride = a.width * 4;
  let total = 0;
  const patches: Array<{ top: number; bottom: number; left: number; right: number }> = [];
  for (let y = 0; y < overlap; y += 16) {
    const h = Math.min(16, overlap - y);
    const from = (a.height - overlap + y) * stride;
    const to = y * stride;
    const left = aa.subarray(from, from + h * stride), right = bb.subarray(to, to + h * stride);
    const mismatches = pixelmatch(left, right, undefined, a.width, h, { threshold: 0.025, includeAA: true });
    if (mismatches === 0) continue;
    total += mismatches;
    if (total > a.width * overlap * 0.005) return false;
    const mask = new Uint8ClampedArray(a.width * h * 4);
    pixelmatch(left, right, mask, a.width, h, { threshold: 0.025, includeAA: true, diffMask: true });
    for (let row = 0; row < h; row += 1) {
      let min = a.width, max = -1;
      for (let x = 0; x < a.width; x += 1) if (mask[(row * a.width + x) * 4 + 3]) { min = Math.min(min, x); max = x; }
      if (max < 0) continue;
      const absolute = y + row;
      if (absolute >= overlap - 32) return false;
      let patch = patches[patches.length - 1];
      if (!patch || absolute - patch.bottom > 3) { patch = { top: absolute, bottom: absolute, left: min, right: max }; patches.push(patch); }
      else { patch.bottom = absolute; patch.left = Math.min(patch.left, min); patch.right = Math.max(patch.right, max); }
      if (patches.length > 2 || patch.bottom - patch.top > 80 || patch.right - patch.left > 80) return false;
    }
  }
  return true;
}

export function detectOverlapData(a: Pixels, b: Pixels): Match {
  if (a.width !== b.width) throw new Error("截图宽度不同，请重新截取同宽区域；不会自动拉伸图片。");
  if (sameFrame(a, b)) return { pixels: a.height, confidence: 1 };
  const max = Math.min(a.height, b.height) - (a.height === b.height ? 1 : 0);
  const candidates: Array<{ pixels: number; score: number }> = [];
  for (let pixels = 24; pixels <= max; pixels += 1) {
    const score = coarseDifference(a, b, pixels);
    if (score < 16) candidates.push({ pixels, score });
  }
  candidates.sort((x, y) => x.score - y.score || y.pixels - x.pixels);
  const valid: number[] = [];
  for (const candidate of candidates.slice(0, 32)) {
    if (verifyOverlap(a, b, candidate.pixels)) valid.push(candidate.pixels);
    if (valid.length > 1) return { pixels: 0, confidence: 0 };
  }
  return valid.length === 1 ? { pixels: valid[0], confidence: 1 } : { pixels: 0, confidence: 0 };
}

function equalRow(a: Pixels, b: Pixels, row: number) {
  const start = row * a.width * 4;
  for (let i = start; i < start + a.width * 4; i += 1) if (a.data[i] !== b.data[i]) return false;
  return true;
}

export function fixedEdges(images: Pixels[]) {
  const first = images[0];
  if (images.length < 2 || images.some((image) => image.width !== first.width || image.height !== first.height) || images.every((image) => samePixels(first, image))) return { top: 0, bottom: 0 };
  const limit = Math.min(256, Math.floor(first.height / 4));
  let top = 0, bottom = 0;
  while (top < limit && images.every((image) => equalRow(first, image, top))) top += 1;
  while (bottom < limit && images.every((image) => equalRow(first, image, first.height - 1 - bottom))) bottom += 1;
  return { top, bottom };
}

export function analyzeFrames(images: Pixels[]) {
  if (!images.length) throw new Error("没有图片");
  if (images.some((image) => image.width !== images[0].width)) throw new Error("截图宽度不同，请重新截取同宽区域；不会自动拉伸图片。");
  let edges = fixedEdges(images);
  const crop = (image: Pixels) => ({ width: image.width, height: image.height - edges.top - edges.bottom, data: bytes(image).subarray(edges.top * image.width * 4, (image.height - edges.bottom) * image.width * 4) });
  let matches = images.slice(1).map((image, i) => detectOverlapData(crop(images[i]), crop(image)));
  // Only remove repeated chrome if every seam establishes a verified scrolling offset.
  if ((edges.top || edges.bottom) && matches.some((match) => match.confidence === 0)) {
    edges = { top: 0, bottom: 0 };
    matches = images.slice(1).map((image, i) => detectOverlapData(images[i], image));
  }
  return { edges, matches };
}

// OpenCV locates translation using several textured strips, not sparse RGB samples.
export async function openCV() {
  const { getOpenCV } = await import("./cv.ts");
  return getOpenCV();
}

export async function analyzeFramesCV(images: Pixels[]) {
  if (!images.length) throw new Error("没有图片");
  if (images.some((im) => im.width !== images[0].width)) throw new Error("截图宽度不同，不会自动拉伸图片。");
  const { cv } = await openCV();
  const exact = fixedEdges(images);
  let edges = { ...exact };
  const crop = (im: Pixels, top: number, bottom: number) => ({ width: im.width, height: im.height - top - bottom, data: bytes(im).subarray(top * im.width * 4, (im.height - bottom) * im.width * 4) });
  const locate = (a: Pixels, b: Pixels): Match => {
    if (sameFrame(a, b)) return { pixels: a.height, confidence: 1 };
    const w = a.width, h = Math.min(a.height, b.height);
    // Suppress stationary UI columns only during matching; never crop source columns.
    const moving: number[] = [];
    for (let x = 0; x < w; x += 1) {
      let changed = 0;
      for (let y = 0; y < h; y += 4) {
        const i = (y * w + x) * 4;
        if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 36) changed += 1;
      }
      if (changed > h / 4 * 0.035) moving.push(x);
    }
    if (moving.length < Math.min(24, w / 3)) return { pixels: 0, confidence: 0 };
    const x0 = moving[0], mw = moving[moving.length - 1] - x0 + 1;
    const narrow = (im: Pixels) => {
      const out = new Uint8ClampedArray(mw * im.height * 4);
      for (let y = 0; y < im.height; y += 1) out.set(bytes(im).subarray((y * w + x0) * 4, (y * w + x0 + mw) * 4), y * mw * 4);
      return { width: mw, height: im.height, data: out };
    };
    const na = narrow(a), nb = narrow(b);
    const rgbaA = cv.matFromArray(na.height, mw, cv.CV_8UC4, na.data);
    const rgbaB = cv.matFromArray(nb.height, mw, cv.CV_8UC4, nb.data);
    const ga = new cv.Mat(), gb = new cv.Mat();
    const candidates = new Set<number>();
    try {
      cv.cvtColor(rgbaA, ga, cv.COLOR_RGBA2GRAY); cv.cvtColor(rgbaB, gb, cv.COLOR_RGBA2GRAY);
      for (const th of [...new Set([Math.min(24, h), Math.min(64, Math.max(16, Math.floor(h / 8)))])]) for (const fraction of [0.25, 0.5, 0.75, 1]) {
        const y = Math.min(a.height - th, Math.floor((a.height - th) * fraction));
        const templ = ga.roi(new cv.Rect(0, y, mw, th));
        const scores = new cv.Mat();
        try {
          cv.matchTemplate(gb, templ, scores, cv.TM_CCOEFF_NORMED);
          for (let by = 0; by < scores.rows; by += 1) {
            const overlap = a.height - y + by;
            if (y - by > 0 && overlap >= 24 && overlap <= h && scores.data32F[by] > 0.94) candidates.add(overlap);
          }
        } finally { templ.delete(); scores.delete(); }
      }
      const valid = [...candidates].filter((pixels) => verifyOverlap(na, nb, pixels));
      return valid.length === 1 ? { pixels: valid[0], confidence: 1 } : { pixels: 0, confidence: 0 };
    } finally { rgbaA.delete(); rgbaB.delete(); ga.delete(); gb.delete(); }
  };
  let matches = images.slice(1).map((im, i) => locate(crop(images[i], edges.top, edges.bottom), crop(im, edges.top, edges.bottom)));
  // A translucent sticky title may differ on every frame. Try a bounded header exclusion,
  // Retain it only when extra seams verify without losing an already verified pair.
  if (matches.some((m) => !m.confidence) && images.length > 1) {
    const maxTop = Math.min(128, Math.floor(Math.min(...images.map((im) => im.height)) / 5));
    for (let top = Math.max(exact.top + 8, 8); top <= maxTop; top += 8) {
      const trial = images.slice(1).map((im, i) => locate(crop(images[i], top, exact.bottom), crop(im, top, exact.bottom)));
      if (trial.filter((m) => m.confidence).length > matches.filter((m) => m.confidence).length && matches.every((m, i) => !m.confidence || trial[i].confidence)) {
        edges = { top, bottom: exact.bottom }; matches = trial;
      }
      if (trial.every((m) => m.confidence)) break;
    }
  }
  if (matches.every((m) => !m.confidence) && (edges.top || edges.bottom)) {
    edges = { top: 0, bottom: 0 };
    matches = images.slice(1).map((im, i) => locate(images[i], im));
  }
  return { edges, matches };
}

// Resolve content coordinates within each capture session, including reversals.
// Imports and manually reordered inputs keep their explicit order.
export async function orderCapturedFramesCV(images: Pixels[], groups: Array<string | null>) {
  if (images.length !== groups.length) throw new Error("采集分组数据不完整");
  const order: number[] = [];
  for (let start = 0; start < images.length;) {
    let end = start + 1;
    if (groups[start] !== null) while (end < images.length && groups[end] === groups[start]) end += 1;
    const positions = [{ index: start, y: 0 }];
    for (let index = start + 1; index < end; index += 1) {
      const a = images[index - 1], b = images[index];
      if (a.width !== b.width || a.height !== b.height) throw new Error("采集区域尺寸改变，请分批拼接。");
      let delta = 0;
      if (!sameCaptureViewport(a, b)) {
        const down = await analyzeFramesCV([a, b]);
        const up = await analyzeFramesCV([b, a]);
        const d = down.matches[0], u = up.matches[0];
        if (Boolean(d.confidence) === Boolean(u.confidence)) {
          throw new Error(`第 ${index} / ${index + 1} 张无法可靠判断滚动方向，请在输入中检查顺序后点击重算。`);
        }
        delta = d.confidence ? a.height - down.edges.top - down.edges.bottom - d.pixels
          : -(b.height - up.edges.top - up.edges.bottom - u.pixels);
      }
      positions.push({ index, y: positions[positions.length - 1].y + delta });
    }
    positions.sort((a, b) => a.y - b.y || a.index - b.index);
    // Revisited viewports add no rows. Prefer the newest small transient update.
    for (let i = 0; i < positions.length; i += 1) {
      if (i === 0 || positions[i].y !== positions[i - 1].y) order.push(positions[i].index);
      else if (!sameFrame(images[order[order.length - 1]], images[positions[i].index])) order[order.length - 1] = positions[i].index;
    }
    start = end;
  }
  return order;
}

function sameCaptureViewport(a: Pixels, b: Pixels) {
  if (sameFrame(a, b)) return true;
  if (a.width !== b.width || a.height !== b.height) return false;
  let left = a.width, right = -1, top = a.height, bottom = -1;
  for (let y = 0; y < a.height; y += 1) for (let x = 0; x < a.width; x += 1) {
    const i = (y * a.width + x) * 4;
    if (Math.abs(a.data[i] - b.data[i]) <= 3 && Math.abs(a.data[i + 1] - b.data[i + 1]) <= 3 && Math.abs(a.data[i + 2] - b.data[i + 2]) <= 3) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    if (right - left >= 24 || bottom - top >= 24) return false;
  }
  return verifyOverlap(a, b, a.height) && verifyOverlap(b, a, b.height);
}

export function planSegments(heights: number[], overlaps: number[], edges = { top: 0, bottom: 0 }) {
  let y = 0;
  return heights.map((height, index) => {
    const crop = index === 0 ? 0 : edges.top + Math.max(0, Math.min(height - edges.top - edges.bottom, Math.round(overlaps[index - 1] ?? 0)));
    const bottom = index === heights.length - 1 ? 0 : edges.bottom;
    const segment = { crop, y, height: height - bottom - crop };
    y += segment.height;
    return segment;
  });
}

export function interpolateStroke(points: Array<{ x: number; y: number }>, size: number) {
  const result: Array<{ x: number; y: number }> = [];
  points.forEach((point, index) => {
    if (index === 0) { result.push(point); return; }
    const previous = points[index - 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(point.x - previous.x, point.y - previous.y) / Math.max(1, size / 3)));
    for (let step = 1; step <= steps; step += 1) result.push({ x: previous.x + (point.x - previous.x) * step / steps, y: previous.y + (point.y - previous.y) * step / steps });
  });
  return result;
}
