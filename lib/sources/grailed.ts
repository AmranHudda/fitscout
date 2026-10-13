import type { Listing } from "../types";

// Grailed's listing search runs on Algolia with a public, search-only key that grailed.com ships
// to every visitor (window __NEXT_DATA__ → public_config.algolia). Unofficial: if Grailed rotates
// the key, set GRAILED_ALGOLIA_KEY from the site's page source.
const APP_ID = process.env.GRAILED_ALGOLIA_APP_ID ?? "MNRWEFSS2Q";
const SEARCH_KEY = process.env.GRAILED_ALGOLIA_KEY ?? "c89dbaddf15fe70e1941a109bf7c2a3d";

const CONDITION: Record<string, string> = {
  is_new: "New / never worn",
  is_gently_used: "Gently used",
  is_used: "Used",
  is_worn: "Very worn",
};

interface GrailedHit {
  id: number;
  title: string;
  price_i: number;
  size?: string;
  designer_names?: string;
  condition?: string;
  location?: string;
  created_at?: string;
  cover_photo?: { url?: string };
  shipping?: { us?: { amount: number; enabled: boolean } };
  sold_price?: number;
  sold_at?: string;
}

async function query(indexName: string, params: Record<string, string>) {
  const res = await fetch(`https://${APP_ID}-dsn.algolia.net/1/indexes/*/queries`, {
    method: "POST",
    headers: { "x-algolia-application-id": APP_ID, "x-algolia-api-key": SEARCH_KEY, "content-type": "application/json" },
    body: JSON.stringify({ requests: [{ indexName, params: new URLSearchParams(params).toString() }] }),
  });
  if (!res.ok) throw new Error(`Grailed search: HTTP ${res.status}`);
  const json = (await res.json()) as { results: { hits: GrailedHit[] }[] };
  return json.results[0]?.hits ?? [];
}

export function mapGrailedHit(hit: GrailedHit): Listing | null {
  // Skip listings that can't ship to the US.
  if (hit.shipping?.us && !hit.shipping.us.enabled) return null;
  const ship = hit.shipping?.us?.enabled ? hit.shipping.us.amount : null;
  return {
    id: `grailed:${hit.id}`,
    source: "grailed",
    sourceId: String(hit.id),
    url: `https://www.grailed.com/listings/${hit.id}`,
    title: hit.title,
    price: hit.price_i,
    currency: "USD",
    images: hit.cover_photo?.url ? [hit.cover_photo.url] : [],
    size: hit.size ?? null,
    brand: hit.designer_names ?? null,
    condition: hit.condition ? (CONDITION[hit.condition] ?? hit.condition) : null,
    description: ship != null ? `Ships to US for $${ship}.` : null,
    location: hit.location ?? null,
    listedAt: hit.created_at ?? null,
    format: "fixed",
  };
}

// Grailed is mostly menswear, so titles rarely say "mens"; requiring it hides most matches.
export const grailedQuery = (q: string) => q.replace(/\bmen'?s?\b/gi, " ").replace(/\s+/g, " ").trim();

export async function searchGrailed(q: string, opts: { maxPrice?: number | null; limit?: number } = {}): Promise<Listing[]> {
  // Every word must match by default, so long profile searches often found nothing. Searches put
  // brand and item first, so drop words from the end until something matches.
  const params: Record<string, string> = { query: grailedQuery(q), hitsPerPage: String(Math.min(opts.limit ?? 30, 100)), removeWordsIfNoResults: "lastWords" };
  if (opts.maxPrice) params.numericFilters = JSON.stringify([`price_i<=${opts.maxPrice}`]);
  const hits = await query("Listing_by_date_added_production", params);
  return hits.map(mapGrailedHit).filter((l): l is Listing => l !== null);
}

// What this kind of item actually sold for on Grailed recently.
export async function grailedSoldComps(q: string) {
  const hits = await query("Listing_sold_production", { query: q, hitsPerPage: "40", removeWordsIfNoResults: "allOptional" });
  const cutoff = Date.now() - 365 * 86_400_000;
  const sold = hits.filter((h) => (h.sold_price ?? 0) > 0 && (!h.sold_at || Date.parse(h.sold_at) > cutoff));
  if (sold.length < 3) return null;
  const prices = sold.map((h) => h.sold_price!).sort((a, b) => a - b);
  const at = (p: number) => prices[Math.min(prices.length - 1, Math.floor(p * prices.length))];
  return {
    source: "grailed sold" as const,
    query: q,
    n: prices.length,
    p25: at(0.25),
    median: at(0.5),
    p75: at(0.75),
    examples: sold.slice(0, 5).map((h) => ({ title: h.title, soldPrice: h.sold_price!, soldAt: h.sold_at ?? null, url: `https://www.grailed.com/listings/${h.id}` })),
  };
}

export type SoldComps = NonNullable<Awaited<ReturnType<typeof grailedSoldComps>>>;
