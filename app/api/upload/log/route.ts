import { z } from "zod";
import { uploadKeyOk } from "@/lib/uploads";

const Failure = z.object({
  stage: z.string().max(20),
  message: z.string().max(300),
  name: z.string().max(120),
  type: z.string().max(60),
  size: z.number().nonnegative(),
});

// Photos that fail on the phone (before or during upload) are reported here so they show up in the logs.
export async function POST(req: Request) {
  if (!uploadKeyOk(new URL(req.url).searchParams.get("k"))) return new Response("Bad link", { status: 403 });
  const parsed = Failure.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return new Response(null, { status: 400 });
  const f = parsed.data;
  console.warn(`phone upload failed at ${f.stage}: ${f.message} (${f.name}, ${f.type || "no type"}, ${(f.size / 1e6).toFixed(1)}MB)`);
  return new Response(null, { status: 204 });
}
