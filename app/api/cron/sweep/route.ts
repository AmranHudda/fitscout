import { config } from "@/lib/config";
import { NoTasteProfile } from "@/lib/pipeline";
import { tokenMatches } from "@/lib/sign";
import { runDaily } from "@/lib/sweep";

export const maxDuration = 300;

// The morning run: the tuning agent, then the sweep. Called by Vercel Cron (Bearer CRON_SECRET) or anything holding FITSCOUT_TOKEN.
export async function GET(req: Request) {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!tokenMatches(bearer, process.env.CRON_SECRET ?? "") && !tokenMatches(bearer, config.token)) {
    return new Response("Unauthorized", { status: 401 });
  }
  try {
    return Response.json(await runDaily());
  } catch (err) {
    const noProfile = err instanceof NoTasteProfile;
    return Response.json({ error: noProfile ? err.message : `sweep failed: ${(err as Error).message}` }, { status: noProfile ? 409 : 500 });
  }
}
