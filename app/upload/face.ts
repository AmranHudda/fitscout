// On-device face matching for the upload page. Your reference selfies, and every face in your
// photos, stay on the phone. All that leaves it is a green box drawn around your face on the copy
// of the photo the model sees, so the model is told who you are instead of recognizing anyone.
type FaceApi = typeof import("@vladmandic/face-api");

const MODELS = "/face-models";
const KEY = "fitscout:me";
// face-api's usual cutoff is 0.6. Stricter here: a wrong match is worse than asking.
const MATCH_DISTANCE = 0.5;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Face {
  box: Box;
  descriptor: number[];
}

let api: Promise<FaceApi> | undefined;
function load() {
  api ??= (async () => {
    const faceapi = await import("@vladmandic/face-api");
    // The bundled tfjs has ready(); face-api's typings just leave it out.
    await (faceapi.tf as unknown as { ready(): Promise<void> }).ready();
    await Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri(MODELS),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODELS),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODELS),
    ]);
    return faceapi;
  })().catch((err) => {
    api = undefined; // let the next photo retry
    throw err;
  });
  return api;
}

async function detect(canvas: HTMLCanvasElement, minConfidence: number): Promise<Face[]> {
  const faceapi = await load();
  const found = await faceapi
    .detectAllFaces(canvas, new faceapi.SsdMobilenetv1Options({ minConfidence, maxResults: 40 }))
    .withFaceLandmarks()
    .withFaceDescriptors();
  return found.map((f) => {
    const { x, y, width, height } = f.detection.box;
    return { box: { x, y, width, height }, descriptor: Array.from(f.descriptor) };
  });
}

// Gives a canvas's memory back right away. Safari caps total canvas memory per page and frees it
// lazily, so a long batch of photos otherwise starts failing partway through.
export function release(canvas: HTMLCanvasElement) {
  canvas.width = 0;
  canvas.height = 0;
}

// One face search at a time: parallel uploads would otherwise stack GPU work and memory on a phone.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

// Detects on a temporary copy, then frees it.
async function detectCopy(copy: HTMLCanvasElement, minConfidence: number) {
  try {
    return await detect(copy, minConfidence);
  } finally {
    release(copy);
  }
}

function crop(canvas: HTMLCanvasElement, dx: number, dy: number, width: number, height: number) {
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  out.getContext("2d")!.drawImage(canvas, dx, dy, width, height, 0, 0, width, height);
  return out;
}

// A quarter turn clockwise (1) or counterclockwise (3).
function rotate(canvas: HTMLCanvasElement, turns: 1 | 3) {
  const out = document.createElement("canvas");
  out.width = canvas.height;
  out.height = canvas.width;
  const ctx = out.getContext("2d")!;
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((turns * Math.PI) / 2);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

// Maps a box found on a rotated copy back onto the original photo.
function unrotate(b: Box, turns: 1 | 3, canvas: HTMLCanvasElement): Box {
  return turns === 1
    ? { x: b.y, y: canvas.height - (b.x + b.width), width: b.height, height: b.width }
    : { x: canvas.width - (b.y + b.height), y: b.x, width: b.height, height: b.width };
}

// Looks harder only when it has to: the whole photo, then overlapping close-ups of each quarter
// (a face in a full-length mirror shot is small), then the photo turned sideways (in case the
// browser ignored the photo's rotation), until `enough` is satisfied or time runs out.
async function search(canvas: HTMLCanvasElement, minConfidence: number, enough: (found: Face[]) => boolean, deadline = Infinity) {
  let found = await detect(canvas, minConfidence);
  const done = () => enough(found) || Date.now() > deadline;
  if (done()) return found;
  const w = Math.round(canvas.width * 0.6);
  const h = Math.round(canvas.height * 0.6);
  for (const [dx, dy] of [[0, 0], [canvas.width - w, 0], [0, canvas.height - h], [canvas.width - w, canvas.height - h]]) {
    const more = await detectCopy(crop(canvas, dx, dy, w, h), minConfidence);
    found = found.concat(more.map((f) => ({ ...f, box: { ...f.box, x: f.box.x + dx, y: f.box.y + dy } })));
    if (done()) return found;
  }
  for (const turns of [1, 3] as const) {
    const more = await detectCopy(rotate(canvas, turns), minConfidence);
    found = found.concat(more.map((f) => ({ ...f, box: unrotate(f.box, turns, canvas) })));
    if (done()) return found;
  }
  return found;
}

// The face in a reference photo: the largest one, so a selfie with someone behind you still works.
export function referenceFace(canvas: HTMLCanvasElement) {
  return serial(async () => {
    const all = await search(canvas, 0.35, (found) => found.length > 0);
    return all.sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0]?.descriptor ?? null;
  });
}

const distance = (a: number[], b: number[]) => Math.sqrt(a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0));

// Where your face is in the photo, or null when no face is close enough to your reference photos
// (or the search ran past `deadline`, so an upload never waits on it for long).
export function findMe(canvas: HTMLCanvasElement, me: number[][], deadline = Infinity): Promise<Box | null> {
  return serial(async () => {
    const closeness = (face: Face) => Math.min(...me.map((ref) => distance(face.descriptor, ref)));
    const found = await search(canvas, 0.45, (faces) => faces.some((f) => closeness(f) < MATCH_DISTANCE), deadline);
    let best: { box: Box; d: number } | null = null;
    for (const face of found) {
      const d = closeness(face);
      if (d < MATCH_DISTANCE && (!best || d < best.d)) best = { box: face.box, d };
    }
    return best?.box ?? null;
  });
}

// A copy of the photo with a bright green box around your face, for the model only.
export function markFace(canvas: HTMLCanvasElement, box: Box) {
  const copy = document.createElement("canvas");
  copy.width = canvas.width;
  copy.height = canvas.height;
  const ctx = copy.getContext("2d")!;
  ctx.drawImage(canvas, 0, 0);
  const pad = box.width * 0.3;
  ctx.lineWidth = Math.max(4, Math.round(canvas.width / 250));
  ctx.strokeStyle = "#00ff3c";
  ctx.strokeRect(box.x - pad, box.y - pad, box.width + 2 * pad, box.height + 2 * pad);
  return copy;
}

// Your reference face signatures live only in this browser.
export function loadMe(): number[][] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}
export function saveMe(me: number[][]) {
  try {
    if (me.length) localStorage.setItem(KEY, JSON.stringify(me));
    else localStorage.removeItem(KEY);
  } catch {
    // Private browsing: matching still works until the page closes.
  }
}
