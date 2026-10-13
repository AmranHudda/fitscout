import { appUrl, uploadKeyOk } from "@/lib/uploads";
import { sendWebPush } from "@/lib/webpush";

// "Send a test" in the app.
export async function POST(req: Request) {
  if (!uploadKeyOk(new URL(req.url).searchParams.get("k"))) return new Response("Bad link", { status: 403 });
  const sent = await sendWebPush({ title: "fitscout is set up", body: "Finds will show up here. Tap to open the app.", url: appUrl(), tag: "test" });
  return Response.json({ sent });
}
