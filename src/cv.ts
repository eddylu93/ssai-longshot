import cvModule from "@techstark/opencv-js";

let ready: Promise<{ cv: typeof cvModule }> | undefined;

export function getOpenCV() {
  if (!ready) ready = (async () => {
    let cv = cvModule;
    if (cvModule instanceof Promise) cv = await cvModule;
    else if (!cvModule.Mat) await new Promise<void>((resolve) => { cvModule.onRuntimeInitialized = resolve; });
    // Do not resolve the Emscripten thenable directly: Vite/Promise interop can loop.
    return { cv };
  })();
  return ready;
}
