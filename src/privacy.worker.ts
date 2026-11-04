import type { Pixels } from "./stitching";
import { detectChatLayout } from "./privacy-cv";
import { privacyBoxes, type TextBox, type PrivacyOptions } from "./privacy";

self.onmessage = async ({ data }: MessageEvent<{ image: Pixels; lines: TextBox[]; options: PrivacyOptions }>) => {
  try {
    const { image } = data;
    const { avatars, bubbles } = await detectChatLayout(image, data.lines);
    self.postMessage({ boxes: privacyBoxes(data.lines, avatars, data.options, image.width, image.height, bubbles) });
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
