import { after } from "next/server";
import { z } from "zod";
import { newHunt } from "@/lib/hunts";
import { BudgetExceeded } from "@/lib/openai";
import { getHunt, removeHunt, saveHunt } from "@/lib/store";
import { runHunt } from "@/lib/sweep";
import { uploadKeyOk } from "@/lib/uploads";

export const maxDuration = 300;

const ok = (req: Request) => uploadKeyOk(new URL(req.url).searchParams.get("k"));

const Add = z
  .object({
    want: z.string().trim().max(300).default(""),
    size: z.string().trim().max(40).nullish(),
    maxPrice: z.coerce.number().positive().nullish(),
    photo: z.string().regex(/^data:image\/jpeg;base64,/).max(400_000).nullish(),
  })
  .refine((v) => v.want || v.photo, "Add a photo or describe the item.");

// The tracker: add an item to hunt for (photo and/or words); it searches right away.
export async function POST(req: Request) {
  if (!ok(req)) return new Response("Bad link", { status: 403 });
  const parsed = Add.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid item" }, { status: 400 });
  try {
    const hunt = await newHunt({ want: parsed.data.want, size: parsed.data.size || null, maxPrice: parsed.data.maxPrice ?? null, photo: parsed.data.photo ?? null });
    await saveHunt(hunt);
    after(async () => {
      try {
        const run = await runHunt(hunt);
        console.log(`tracker "${hunt.want}": judged ${run.judged}, matches ${run.candidates}`);
      } catch (err) {
        console.error(`tracker "${hunt.want}" search failed:`, (err as Error).message);
      }
    });
    const { photo: _photo, ...rest } = hunt;
    return Response.json({ hunt: { ...rest, hasPhoto: !!hunt.photo } }, { status: 201 });
  } catch (err) {
    return Response.json({ error: err instanceof BudgetExceeded ? err.message : "Couldn't set that up. Try again." }, { status: err instanceof BudgetExceeded ? 429 : 500 });
  }
}

const Change = z.object({ id: z.string().max(20), action: z.enum(["pause", "resume", "remove"]) });

export async function PATCH(req: Request) {
  if (!ok(req)) return new Response("Bad link", { status: 403 });
  const parsed = Change.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid change" }, { status: 400 });
  const hunt = await getHunt(parsed.data.id);
  if (!hunt) return Response.json({ error: "Not found" }, { status: 404 });
  if (parsed.data.action === "remove") await removeHunt(hunt.id);
  else await saveHunt({ ...hunt, active: parsed.data.action === "resume" });
  return new Response(null, { status: 204 });
}
