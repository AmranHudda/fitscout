import { verify } from "@/lib/sign";
import { rateFind } from "@/lib/store";

// Target of the 👍/👎 buttons on push notifications. The signature binds the id to the rating.
async function rate(req: Request) {
  const params = new URL(req.url).searchParams;
  const id = params.get("id") ?? "";
  const rating = params.get("r");
  if ((rating !== "like" && rating !== "dislike") || !verify(`${id}:${rating}`, params.get("s") ?? "")) {
    return new Response("Bad link", { status: 403 });
  }
  const find = await rateFind(id, rating);
  return new Response(find ? `Got it: ${rating === "like" ? "👍" : "👎"} ${find.verdict?.item ?? find.title}` : "That find expired.", {
    status: find ? 200 : 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export { rate as GET, rate as POST };
