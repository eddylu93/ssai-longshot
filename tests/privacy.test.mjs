import { test } from "node:test";
import assert from "node:assert/strict";
import { isTime, privacyBoxes } from "../src/privacy.ts";
import { detectAvatarBoxes, detectChatLayout } from "../src/privacy-cv.ts";

test("timestamps recognized without treating body sentences as dates", () => {
  for (const t of ["12:34", "昨天 18:25", "2026年11月3日", "星期一 08:09", "下午3:25"]) assert.equal(isTime(t), true, t);
  for (const t of ["明天12:34发货", "2026件", "数量 12:34", "张三"]) assert.equal(isTime(t), false, t);
});
test("privacy options preserve body and independently select categories", () => {
  const avatar = { x: 20, y: 80, width: 40, height: 40 };
  const lines = [{ text: "张三", x: 70, y: 81, width: 30, height: 12 }, { text: "收到，明天发货", x: 70, y: 100, width: 150, height: 18 }, { text: "昨天 18:25", x: 200, y: 40, width: 90, height: 16 }];
  const all = privacyBoxes(lines, [avatar], { time: true, names: true, avatars: true }, 500, 500);
  assert.deepEqual(all.map(b => b.category), ["avatars", "names", "time"]);
  assert.ok(all.every(b => b.y < 100));
  assert.deepEqual(privacyBoxes(lines, [avatar], { time: false, names: false, avatars: false }, 500, 500), []);
});
test("equal sized body lines are not automatically called nicknames", () => {
  const lines = [{ text: "你好", x: 70, y: 81, width: 30, height: 18 }, { text: "明天发货", x: 70, y: 105, width: 90, height: 18 }];
  assert.deepEqual(privacyBoxes(lines, [{ x: 20, y: 80, width: 40, height: 40 }], { time: false, names: true, avatars: false }, 500, 500), []);
});
test("redactions are padded and clipped to image bounds", () => {
  const [b] = privacyBoxes([{ text: "12:34", x: 0, y: 0, width: 30, height: 10 }], [], { time: true, names: false, avatars: false }, 32, 12);
  assert.deepEqual(b, { category: "time", x: 0, y: 0, width: 32, height: 12 });
});

test("right-side sender labels are detected without covering body text", () => {
  const lines = [{ text: "小林", x: 607, y: 273, width: 27, height: 13 }, { text: "明天整理完整清单", x: 351, y: 307, width: 223, height: 25 }];
  const boxes = privacyBoxes(lines, [{ x: 651, y: 269, width: 45, height: 45 }], { time: false, names: true, avatars: false }, 720, 1100);
  assert.equal(boxes.length, 1);
  assert.ok(boxes[0].y + boxes[0].height < 307);
});

function squareImage(squares) {
  const width = 500, height = 500, data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [x0, y0, size] of squares) for (let y = y0; y < y0 + size; y++) for (let x = x0; x < x0 + size; x++) {
    const i = (y * width + x) * 4; data[i] = 25; data[i + 1] = 95; data[i + 2] = 80;
  }
  return { width, height, data };
}
test("OpenCV identifies repeated left and right avatar lanes", async () => {
  const avatars = await detectAvatarBoxes(squareImage([[20, 40, 40], [20, 160, 40], [440, 40, 40], [440, 160, 40], [410, 360, 24]]));
  assert.equal(avatars.length, 4);
  assert.ok(avatars.every(a => [19, 439].includes(a.x)));
});
test("an isolated square is not sufficient to identify an avatar lane", async () => {
  assert.deepEqual(await detectAvatarBoxes(squareImage([[20, 40, 40]])), []);
});

test("group names above photo, sticker and equal-font messages are redacted, not their content", () => {
  const avatars = [80, 230, 380].map((y) => ({ x: 20, y, width: 40, height: 40 }));
  const bubbles = [105, 255, 405].map((y) => ({ x: 72, y, width: 220, height: 80 }));
  const lines = [{ text: "小周", x: 72, y: 82, width: 38, height: 18 }, { text: "收到", x: 88, y: 124, width: 38, height: 18 },
    { text: "小林（设计组）", x: 72, y: 232, width: 140, height: 18 }, { text: "图片内文字不要打码", x: 90, y: 280, width: 160, height: 18 },
    { text: "测试群成员🙂昵称超过原来二十四字限制的完整名称", x: 72, y: 382, width: 280, height: 18 }];
  const boxes = privacyBoxes(lines, avatars, { time: false, names: true, avatars: false }, 500, 700, bubbles);
  assert.equal(boxes.length, 3);
  assert.deepEqual(boxes.map((b) => b.y), [78, 228, 378]);
  assert.ok(boxes.every((b) => b.category === "names"));
});

test("right-side group names, split labels and role suffixes are covered without masking bubble text", () => {
  const lines = [{ text: "小林", x: 340, y: 82, width: 40, height: 18 }, { text: "管理员", x: 388, y: 82, width: 52, height: 18 },
    { text: "小林", x: 270, y: 128, width: 40, height: 18 }];
  const boxes = privacyBoxes(lines, [{ x: 450, y: 80, width: 40, height: 40 }], { time: false, names: true, avatars: false }, 500, 400,
    [{ x: 250, y: 110, width: 190, height: 70 }]);
  assert.equal(boxes.length, 2);
  assert.ok(boxes.every((b) => b.y === 78));
});

test("plain two-line messages inside bubbles are not names even with repeated avatars", () => {
  const lines = [80, 230].flatMap((y) => [{ text: "这是一条普通消息", x: 86, y: y + 12, width: 160, height: 18 }, { text: "不要盖住正文", x: 86, y: y + 42, width: 140, height: 18 }]);
  const boxes = privacyBoxes(lines, [80, 230].map((y) => ({ x: 20, y, width: 40, height: 40 })), { time: false, names: true, avatars: false }, 500, 500,
    [80, 230].map((y) => ({ x: 72, y, width: 220, height: 80 })));
  assert.deepEqual(boxes, []);
});

test("confirmed names repeat over unreadable content but identical words in the body are preserved", () => {
  const lines = [{ text: "小周", x: 72, y: 82, width: 38, height: 16 }, { text: "明天发货", x: 72, y: 112, width: 120, height: 22 },
    { text: "小周", x: 72, y: 232, width: 38, height: 16 }, { text: "小周", x: 88, y: 424, width: 38, height: 16 }];
  const boxes = privacyBoxes(lines, [80, 230, 400].map((y) => ({ x: 20, y, width: 40, height: 40 })), { time: false, names: true, avatars: false }, 500, 700,
    [{ x: 72, y: 405, width: 220, height: 80 }]);
  assert.deepEqual(boxes.map((b) => b.y), [78, 228]);
});

function groupPixels(dark = false) {
  const width = 500, height = 700, data = new Uint8ClampedArray(width * height * 4);
  const fill = (x, y, w, h, color) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) data.set([...color, 255], (yy * width + xx) * 4); };
  fill(0, 0, width, height, dark ? [30, 30, 30] : [242, 242, 242]);
  for (const y of [80, 230, 380]) { fill(20, y, 40, 40, [30, 120, 80]); fill(72, y + 26, 220, 80, dark ? [52, 52, 52] : [255, 255, 255]); }
  fill(440, 530, 40, 40, [35, 90, 140]); fill(250, 556, 178, 80, [80, 160, 100]);
  return { width, height, data };
}

test("OpenCV message geometry supports light/dark group chats and an isolated right sender", async () => {
  const lines = [80, 230, 380].map((y, i) => ({ text: `成员${i + 1}`, x: 72, y: y + 2, width: 60, height: 18 }));
  lines.push({ text: "自己", x: 385, y: 532, width: 40, height: 18 });
  for (const dark of [false, true]) {
    const image = groupPixels(dark);
    const layout = await detectChatLayout(image, lines);
    assert.equal(layout.avatars.length, 4);
    assert.equal(layout.bubbles.length, 4);
    const masks = privacyBoxes(lines, layout.avatars, { time: false, names: true, avatars: true }, image.width, image.height, layout.bubbles);
    assert.equal(masks.filter((b) => b.category === "names").length, 4);
    assert.equal(masks.filter((b) => b.category === "avatars").length, 4);
  }
});
