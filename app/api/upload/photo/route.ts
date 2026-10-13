import { get } from "@vercel/blob";
import { PHOTO_PATH, uploadKeyOk } from "@/lib/uploads";

// Serves an uploaded photo back to the upload page (the store is private), so group photos
// from an earlier visit can still be shown when asking which person is you.
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  if (!uploadKeyOk(params.get("k"))) return new Response("Bad link", { status: 403 });
  const path = params.get("p") ?? "";
  if (!PHOTO_PATH.test(path)) return new Response("Not found", { status: 404 });
  const result = await get(path, { access: "private" }).catch(() => null);
  if (!result?.stream) return new Response("Not found", { status: 404 });
  return new Response(result.stream, { headers: { "content-type": result.blob.contentType, "cache-control": "private, max-age=86400" } });
}
