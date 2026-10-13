import { z } from "zod";
import { removePushSub, savePushSub } from "@/lib/store";
import { uploadKeyOk } from "@/lib/uploads";

const Subscription = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});

// The home-screen app registers (POST) or drops (DELETE) its push subscription here.
async function handle(req: Request) {
  if (!uploadKeyOk(new URL(req.url).searchParams.get("k"))) return new Response("Bad link", { status: 403 });
  const parsed = Subscription.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid subscription" }, { status: 400 });
  if (req.method === "DELETE") await removePushSub(parsed.data.endpoint);
  else await savePushSub({ endpoint: parsed.data.endpoint, keys: parsed.data.keys });
  return new Response(null, { status: 204 });
}

export { handle as POST, handle as DELETE };
