import { STAGES } from "./constants.js";

// 4:3, matching the viewport the frame is displayed in.
const FRAME_W = 1000;
const FRAME_H = 750;
const MASK = "10, 8, 6";

export class ImageSourceError extends Error {}

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Must be set before .src. Without it the canvas is tainted and export
    // throws, so a non-CORS host makes the image unusable for occlusion.
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new ImageSourceError("Image could not be loaded from that URL."));
    img.src = url;
  });
}

function newCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = FRAME_W;
  canvas.height = FRAME_H;
  return canvas;
}

// The security boundary: the mask is composited over the image here, so the
// hidden pixels are destroyed before anything is encoded or transmitted.
export function renderStageCanvas(img, stageIndex) {
  const canvas = newCanvas();
  drawStage(canvas.getContext("2d"), img, stageIndex);
  return canvas;
}

function drawStage(ctx, img, stageIndex) {
  const { scale, vignette } = STAGES[stageIndex];

  ctx.fillStyle = "#0A0806";
  ctx.fillRect(0, 0, FRAME_W, FRAME_H);

  // object-fit: contain, then the aperture's magnification. Cover would crop
  // portraits (Mona Lisa, Eiffel Tower) so FULL still missed the subject.
  const fit = Math.min(FRAME_W / img.naturalWidth, FRAME_H / img.naturalHeight);
  const w = img.naturalWidth * fit * scale;
  const h = img.naturalHeight * fit * scale;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, (FRAME_W - w) / 2, (FRAME_H - h) / 2, w, h);

  // A CSS radial-gradient's 100% is the distance to the farthest corner.
  const radius = Math.hypot(FRAME_W / 2, FRAME_H / 2);
  const inner = (vignette / 100) * radius;
  const outer = ((vignette + 16) / 100) * radius;
  if (inner >= radius) return; // aperture is wider than the frame: nothing to hide

  // Deliberately fully opaque. The browser-side version used 0.97 alpha, which
  // left a faint but recoverable ghost of the hidden image underneath.
  const mask = ctx.createRadialGradient(FRAME_W / 2, FRAME_H / 2, inner, FRAME_W / 2, FRAME_H / 2, outer);
  mask.addColorStop(0, `rgba(${MASK}, 0)`);
  mask.addColorStop(1, `rgba(${MASK}, 1)`);
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, FRAME_W, FRAME_H);
}

function encode(canvas) {
  const webp = canvas.toDataURL("image/webp", 0.82);
  if (webp.startsWith("data:image/webp")) return webp;
  return canvas.toDataURL("image/jpeg", 0.82);
}

// Throws if the image host doesn't allow cross-origin reads, which we want to
// surface while the host is still building the setlist rather than mid-round.
export async function assertUsableImage(url) {
  const img = await loadImage(url);
  const canvas = newCanvas();
  try {
    canvas.getContext("2d").drawImage(img, 0, 0, 1, 1);
    encode(canvas);
  } catch {
    throw new ImageSourceError(
      "That host doesn't allow cross-origin image reads, so the aperture can't be applied safely. Try a different URL.",
    );
  }
  return img;
}

// One flattened image per aperture stage. Everything outside the aperture is
// solid black in the encoded bytes, so a stage's frame carries no trace of what
// later stages will reveal.
export async function renderRoundFrames(url) {
  const img = await assertUsableImage(url);
  return STAGES.map((_, i) => encode(renderStageCanvas(img, i)));
}
