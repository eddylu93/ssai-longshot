export type Transform = { x: number; y: number; scale: number };
export type Size = { width: number; height: number };

export function fitTransform(image: Size, viewport: Size): Transform {
  const scale = Math.min(1, Math.max(1, viewport.width - 24) / Math.max(1, image.width));
  return { x: (viewport.width - image.width * scale) / 2, y: Math.max(12, (viewport.height - image.height * scale) / 2), scale };
}

export function constrainTransform(t: Transform, image: Size, viewport: Size): Transform {
  const w = image.width * t.scale, h = image.height * t.scale;
  return { ...t, x: w <= viewport.width ? (viewport.width - w) / 2 : Math.max(viewport.width - w - 24, Math.min(24, t.x)), y: h <= viewport.height ? (viewport.height - h) / 2 : Math.max(viewport.height - h - 24, Math.min(24, t.y)) };
}

export function zoomAt(t: Transform, pointer: { x: number; y: number }, delta: number, image: Size, viewport: Size): Transform {
  const min = Math.min(0.08, (viewport.height - 24) / Math.max(1, image.height), (viewport.width - 24) / Math.max(1, image.width));
  const scale = Math.max(Math.max(0.005, min), Math.min(4, t.scale * Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.002)));
  const factor = scale / t.scale;
  return constrainTransform({ scale, x: pointer.x - (pointer.x - t.x) * factor, y: pointer.y - (pointer.y - t.y) * factor }, image, viewport);
}

export function exportDecision(hasResult: boolean, busy: boolean, dirty: boolean, uncertain: number) {
  if (!hasResult || busy || dirty) return "blocked";
  return uncertain > 0 ? "confirm" : "ready";
}
