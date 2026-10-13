import { z } from "zod";
import { saveDetails, uploadKeyOk } from "@/lib/uploads";

const num = z.coerce.number().positive().optional();
const Details = z.object({
  sizes: z
    .object({ tops: z.string().max(40).optional(), bottoms: z.string().max(40).optional(), shoes: z.string().max(40).optional(), baggy: z.boolean().optional() })
    .optional(),
  budget: z.object({ usualMax: num, grailMax: num }).optional(),
  location: z.object({ zip: z.string().max(10).optional(), radiusMi: num }).optional(),
  brands: z.array(z.string().max(40)).max(40).optional(),
});

export async function POST(req: Request) {
  if (!uploadKeyOk(new URL(req.url).searchParams.get("k"))) return new Response("Bad link", { status: 403 });
  const parsed = Details.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid details" }, { status: 400 });
  const taste = await saveDetails(parsed.data);
  return Response.json({ sizes: taste.sizes, budget: taste.budget, location: taste.location, brands: taste.myBrands ?? [] });
}
