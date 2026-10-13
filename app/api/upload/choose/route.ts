import { z } from "zod";
import { PHOTO_PATH, pickOutfit, uploadKeyOk } from "@/lib/uploads";

const Choice = z.object({ photo: z.string().regex(PHOTO_PATH), outfit: z.number().int().min(-1).max(5) });

// Sets which person in a group photo is you (-1: none of them).
export async function POST(req: Request) {
  if (!uploadKeyOk(new URL(req.url).searchParams.get("k"))) return new Response("Bad link", { status: 403 });
  const parsed = Choice.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid choice" }, { status: 400 });
  const garments = await pickOutfit(parsed.data.photo, parsed.data.outfit);
  if (!garments) return Response.json({ error: "No such photo or person" }, { status: 404 });
  return Response.json({ garments: garments.map((g) => g.name) });
}
