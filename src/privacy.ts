export type Box = { x: number; y: number; width: number; height: number };
export type TextBox = Box & { text: string };
export type PrivacyOptions = { time: boolean; names: boolean; avatars: boolean };
export type PrivacyBox = Box & { category: "time" | "names" | "avatars" };

export function isTime(text: string) {
  return /^(?:(?:\d{2,4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?|今天|昨天|前天|星期[一二三四五六日天]|周[一二三四五六日天])\s*)?(?:上午|下午|晚上|凌晨|中午)?\s*\d{1,2}[:：]\d{2}(?::\d{2})?$/.test(text.trim())
    || /^(?:\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|今天|昨天|前天|星期[一二三四五六日天])$/.test(text.trim());
}

function inside(line: Box, box: Box) {
  const x = line.x + line.width / 2, y = line.y + line.height / 2;
  return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
}

// Bubble geometry also anchors labels above photos/stickers and equal-size text.
export function privacyBoxes(lines: TextBox[], avatars: Box[], options: PrivacyOptions, width: number, height: number, bubbles: Box[] = []): PrivacyBox[] {
  const boxes: PrivacyBox[] = [];
  if (options.avatars) boxes.push(...avatars.map((b) => ({ ...b, category: "avatars" as const })));
  const senders: Array<{ line: TextBox; avatar: Box }> = [];
  for (const line of lines) {
    if (options.time && isTime(line.text)) boxes.push({ ...line, category: "time" });
    if (!options.names || !line.text.trim() || isTime(line.text) || Array.from(line.text).length > 64 || bubbles.some((b) => inside(line, b))) continue;
    const avatar = avatars.find((a) => {
      const left = a.x < width / 2;
      const distance = left ? line.x - a.x - a.width : a.x - line.x - line.width;
      return distance >= -2 && distance < a.width * 1.5 && line.y >= a.y - a.height * .65 && line.y + line.height <= a.y + a.height * .9 && line.height <= a.height * .75;
    });
    if (!avatar) continue;
    const messageBelow = bubbles.some((b) => {
      const left = avatar.x < width / 2;
      const distance = left ? b.x - avatar.x - avatar.width : avatar.x - b.x - b.width;
      const alignment = left ? Math.abs(b.x - line.x) : Math.abs(b.x + b.width - line.x - line.width);
      return distance >= -2 && distance <= avatar.width * 1.6 && alignment <= avatar.width * 1.3
        && b.y >= line.y + line.height + 1 && b.y - line.y - line.height <= avatar.height * 1.25;
    });
    const bodyBelow = lines.some((b) => b !== line && b.y > line.y + line.height && b.y < line.y + line.height * 3.4 && (Math.abs(b.x - line.x) < line.height || (line.x > width / 2 && b.x > width / 3 && b.x < line.x && b.x + b.width < width * 0.93)) && b.height > line.height * 1.12);
    if (messageBelow || bodyBelow) senders.push({ line, avatar });
  }
  // Repeated, already-confirmed names may appear above content with no readable text.
  for (const line of lines) {
    if (!options.names || senders.some((s) => s.line === line) || bubbles.some((b) => inside(line, b))) continue;
    const profile = senders.find((s) => s.line.text.trim() === line.text.trim() && avatars.some((a) =>
      Math.abs(a.x - s.avatar.x) < s.avatar.width * .3 && Math.abs(a.width - s.avatar.width) < s.avatar.width * .25
      && Math.abs((line.x - a.x) - (s.line.x - s.avatar.x)) < s.avatar.width * .35
      && Math.abs((line.y - a.y) - (s.line.y - s.avatar.y)) < s.avatar.height * .25
      && Math.abs(line.height - s.line.height) < s.line.height * .35));
    if (profile) boxes.push({ ...line, category: "names" });
  }
  for (const { line, avatar } of senders) {
    boxes.push({ ...line, category: "names" });
    // Vision can split a nickname and its suffix/role into multiple same-row boxes.
    let left = line.x, right = line.x + line.width;
    const fragments = lines.filter((part) => part !== line && part.text.trim() && !isTime(part.text)
      && Math.abs(part.y + part.height / 2 - line.y - line.height / 2) < line.height * .4
      && part.height <= line.height * 1.4 && !bubbles.some((b) => inside(part, b))
      && part.x > (avatar.x < width / 2 ? avatar.x + avatar.width : width * .2)
      && part.x + part.width < (avatar.x < width / 2 ? width * .8 : avatar.x));
    const remaining = new Set(fragments);
    let connected = true;
    while (connected) {
      connected = false;
      for (const part of remaining) if (part.x <= right + avatar.width * .6 && part.x + part.width >= left - avatar.width * .6) {
        boxes.push({ ...part, category: "names" }); remaining.delete(part); connected = true;
        left = Math.min(left, part.x); right = Math.max(right, part.x + part.width);
      }
    }
  }
  const unique = boxes.filter((box, index) => !boxes.slice(0, index).some((b) => b.category === box.category && b.x === box.x && b.y === box.y && b.width === box.width && b.height === box.height));
  const lineOrder = (box: Box) => lines.findIndex((line) => line.x === box.x && line.y === box.y && line.width === box.width && line.height === box.height);
  unique.sort((a, b) => a.category === "avatars" ? b.category === "avatars" ? 0 : -1 : b.category === "avatars" ? 1 : lineOrder(a) - lineOrder(b));
  return unique.map((b) => ({ category: b.category, x: Math.max(0, b.x - 4), y: Math.max(0, b.y - 4), width: Math.min(width, b.x + b.width + 4) - Math.max(0, b.x - 4), height: Math.min(height, b.y + b.height + 4) - Math.max(0, b.y - 4) })).filter((b) => b.width > 0 && b.height > 0);
}
