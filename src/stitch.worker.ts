import { analyzeFramesCV, orderCapturedFramesCV, type Pixels } from "./stitching";

self.onmessage = async (event: MessageEvent<{ images: Pixels[]; groups?: Array<string | null> }>) => {
  try {
    const { images, groups } = event.data;
    const order = groups ? await orderCapturedFramesCV(images, groups) : images.map((_, index) => index);
    self.postMessage({ result: { ...await analyzeFramesCV(order.map((index) => images[index])), order } });
  }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
