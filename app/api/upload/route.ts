import { BudgetExceeded } from "@/lib/openai";
import { ingestPhoto, MAX_UPLOAD_BYTES, photoSummary, uploadKeyOk } from "@/lib/uploads";

export const maxDuration = 120;

const IMAGE = /^image\/(jpeg|png|webp)$/;

// One photo per request, already shrunk to ~1600px JPEG on the phone. Sent as form data with an
// optional "marked" copy (the user's face boxed), or as a bare image body from older pages.
async function readPhoto(req: Request) {
  const type = req.headers.get("content-type") ?? "";
  if (!type.startsWith("multipart/form-data")) return { type, bytes: Buffer.from(await req.arrayBuffer()), marked: null };
  const form = await req.formData();
  const photo = form.get("photo");
  const marked = form.get("marked");
  if (!(photo instanceof Blob)) return { type: "", bytes: Buffer.alloc(0), marked: null };
  return {
    type: photo.type,
    bytes: Buffer.from(await photo.arrayBuffer()),
    marked: marked instanceof Blob && marked.size <= MAX_UPLOAD_BYTES ? Buffer.from(await marked.arrayBuffer()) : null,
  };
}

export async function POST(req: Request) {
  const params = new URL(req.url).searchParams;
  if (!uploadKeyOk(params.get("k"))) return new Response("Bad link", { status: 403 });
  const { type, bytes, marked } = await readPhoto(req).catch(() => ({ type: "", bytes: Buffer.alloc(0), marked: null }));
  if (!IMAGE.test(type)) return Response.json({ error: `Unsupported image type ${type || "(none)"}` }, { status: 415 });
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) return Response.json({ error: "Image is empty or too large" }, { status: 413 });
  try {
    const row = await ingestPhoto(bytes, type, (params.get("name") ?? "photo").slice(0, 120), marked);
    return Response.json(photoSummary(row));
  } catch (err) {
    const status = err instanceof BudgetExceeded ? 429 : 500;
    console.error("upload failed:", err);
    return Response.json({ error: err instanceof BudgetExceeded ? err.message : "Couldn't analyze this photo" }, { status });
  }
}
