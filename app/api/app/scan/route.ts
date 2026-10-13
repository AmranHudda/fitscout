import { after } from "next/server";
import { oncePer } from "@/lib/store";
import { runDaily } from "@/lib/sweep";
import { uploadKeyOk } from "@/lib/uploads";

export const maxDuration = 300;

// "Scan now" in the app: tunes the searches (at most every 6 hours) and starts a sweep in the background and returns right away; finds arrive
// as notifications and in the feed. At most once an hour, since each sweep spends OpenAI credit.
export async function POST(req: Request) {
  if (!uploadKeyOk(new URL(req.url).searchParams.get("k"))) return new Response("Bad link", { status: 403 });
  if (!(await oncePer("scan-now", 3600))) return Response.json({ error: "Already scanned in the last hour. Try again later." }, { status: 429 });
  after(async () => {
    try {
      const result = await runDaily("app");
      console.log(`scan now: judged ${result.scout.judged}, pushed ${result.pushed}`);
    } catch (err) {
      console.error("scan now failed:", (err as Error).message);
    }
  });
  return Response.json({ started: true }, { status: 202 });
}
