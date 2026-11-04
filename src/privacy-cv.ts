import { openCV, type Pixels } from "./stitching.ts";
import type { Box, TextBox } from "./privacy";

function distinctBoxes(boxes: Box[]): Box[] {
  const kept: Box[] = [];
  for (const box of boxes.sort((a, b) => b.width * b.height - a.width * a.height)) {
    if (!kept.some((b) => {
      const overlap = Math.max(0, Math.min(box.x + box.width, b.x + b.width) - Math.max(box.x, b.x))
        * Math.max(0, Math.min(box.y + box.height, b.y + b.height) - Math.max(box.y, b.y));
      return overlap / (box.width * box.height) > .9;
    })) kept.push(box);
  }
  return kept;
}

export async function detectChatLayout(image: Pixels, lines: TextBox[] = []): Promise<{ avatars: Box[]; bubbles: Box[] }> {
  const { cv } = await openCV();
  const src = cv.matFromArray(image.height, image.width, cv.CV_8UC4, image.data);
  const gray = new cv.Mat(), edges = new cv.Mat(), hierarchy = new cv.Mat(), contours = new cv.MatVector();
  const candidates: Box[] = [];
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY); cv.Canny(gray, edges, 14, 42);
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i += 1) {
      const c = contours.get(i);
      try {
        const r = cv.boundingRect(c);
        if (r.width >= 20 && r.height >= 14 && cv.contourArea(c) / (r.width * r.height) > .55) candidates.push(r);
      } finally { c.delete(); }
    }
  } finally { src.delete(); gray.delete(); edges.delete(); hierarchy.delete(); contours.delete(); }
  const squares = distinctBoxes(candidates.filter((r) => r.width >= Math.max(20, image.width * .025)
    && r.width <= Math.min(200, image.width * .15) && r.height / r.width > .8 && r.height / r.width < 1.25
    && (r.x < image.width * .25 || r.x + r.width > image.width * .75)));
  const beside = (box: Box, a: Box) => {
    const gap = a.x < image.width / 2 ? box.x - a.x - a.width : a.x - box.x - box.width;
    return gap >= 2 && gap < a.width * 1.6 && (box.width >= a.width * .9 || box.height >= a.height * .9)
      && box.y >= a.y - a.height * .2 && box.y <= a.y + a.height * 2.2;
  };
  const avatars = squares.filter((a) => squares.some((b) => b !== a && Math.abs(a.x - b.x) < a.width * .2
    && Math.abs(a.width - b.width) < a.width * .25 && Math.abs(a.y - b.y) > a.height)
    || lines.some((line) => line.height < a.height * .75 && Array.from(line.text).length <= 64
      && line.y >= a.y - a.height * .65 && line.y + line.height < a.y + a.height
      && candidates.some((b) => beside(b, a) && b.y > line.y + line.height
        && (a.x < image.width / 2 ? Math.abs(b.x - line.x) : Math.abs(b.x + b.width - line.x - line.width)) < a.width * 1.3)));
  const bubbles = distinctBoxes(candidates.filter((box) => avatars.some((a) => beside(box, a))));
  return { avatars, bubbles };
}

export async function detectAvatarBoxes(image: Pixels): Promise<Box[]> {
  return (await detectChatLayout(image)).avatars;
}
