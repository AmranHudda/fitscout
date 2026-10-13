import { renderBrief } from "@/lib/taste";
import { buildProfileFromUploads, uploadKeyOk } from "@/lib/uploads";

export const maxDuration = 300;

export async function POST(req: Request) {
  if (!uploadKeyOk(new URL(req.url).searchParams.get("k"))) return new Response("Bad link", { status: 403 });
  try {
    const { taste } = await buildProfileFromUploads();
    return Response.json({ brief: renderBrief(taste), pillars: taste.pillars, searches: taste.queries.map((q) => q.q), photos: taste.photoCount });
  } catch (err) {
    console.error("build failed:", err);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
