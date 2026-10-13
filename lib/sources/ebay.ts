import { config } from "../config";
import type { Listing } from "../types";

// eBay Browse API (official). Needs a free developer app: EBAY_CLIENT_ID / EBAY_CLIENT_SECRET.
const CLOTHING_CATEGORY = "11450"; // Clothing, Shoes & Accessories

let cached: { token: string; expiresAt: number } | undefined;

async function appToken() {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const basic = Buffer.from(`${config.ebay.clientId}:${config.ebay.clientSecret}`).toString("base64");
  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
  });
  if (!res.ok) throw new Error(`eBay token: HTTP ${res.status}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cached.token;
}

export const ebayEnabled = () => Boolean(config.ebay.clientId && config.ebay.clientSecret);

interface EbayItem {
  itemId: string;
  title: string;
  itemWebUrl: string;
  price?: { value: string; currency: string };
  currentBidPrice?: { value: string; currency: string };
  image?: { imageUrl: string };
  thumbnailImages?: { imageUrl: string }[];
  additionalImages?: { imageUrl: string }[];
  condition?: string;
  itemCreationDate?: string;
  itemEndDate?: string;
  buyingOptions?: string[];
  bidCount?: number;
  itemLocation?: { city?: string; stateOrProvince?: string; country?: string };
}

// eBay's thumbnails default to 225px; ask for the 1600px rendition instead.
const bigImage = (url: string) => url.replace(/s-l\d+\.(jpg|webp|png)/, "s-l1600.$1");

export function mapEbayItem(item: EbayItem): Listing {
  const auction = item.buyingOptions?.includes("AUCTION") && !item.buyingOptions.includes("FIXED_PRICE");
  const price = auction ? (item.currentBidPrice ?? item.price) : item.price;
  const images = [item.image?.imageUrl, ...(item.additionalImages ?? []).map((i) => i.imageUrl)].filter((u): u is string => Boolean(u)).map(bigImage);
  const loc = item.itemLocation;
  return {
    id: `ebay:${item.itemId}`,
    source: "ebay",
    sourceId: item.itemId,
    url: item.itemWebUrl,
    title: item.title,
    price: price ? Number(price.value) : null,
    currency: price?.currency ?? "USD",
    images,
    condition: item.condition ?? null,
    location: loc ? [loc.city, loc.stateOrProvince].filter(Boolean).join(", ") || loc.country || null : null,
    listedAt: item.itemCreationDate ?? null,
    endsAt: auction ? (item.itemEndDate ?? null) : null,
    bidCount: auction ? (item.bidCount ?? 0) : null,
    format: auction ? "auction" : "fixed",
  };
}

export async function searchEbay(query: string, opts: { maxPrice?: number | null; limit?: number } = {}): Promise<Listing[]> {
  const params = new URLSearchParams({
    q: query,
    category_ids: CLOTHING_CATEGORY,
    sort: "newlyListed",
    limit: String(Math.min(opts.limit ?? 30, 200)),
  });
  const filters = ["buyingOptions:{FIXED_PRICE|AUCTION|BEST_OFFER}"];
  if (opts.maxPrice) filters.push(`price:[..${opts.maxPrice}]`, "priceCurrency:USD");
  params.set("filter", filters.join(","));
  const res = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
    headers: { authorization: `Bearer ${await appToken()}`, "x-ebay-c-marketplace-id": config.ebay.marketplace },
  });
  if (!res.ok) throw new Error(`eBay search: HTTP ${res.status}`);
  const json = (await res.json()) as { itemSummaries?: EbayItem[] };
  return (json.itemSummaries ?? []).map(mapEbayItem);
}

// Asking-price comps from active listings. Not sold prices, so treat them as an upper bound.
export async function ebayAskingComps(query: string) {
  const items = await searchEbay(query, { limit: 50 });
  const prices = items
    .filter((i) => i.format === "fixed" && i.price != null)
    .map((i) => i.price!)
    .sort((a, b) => a - b);
  if (prices.length < 3) return null;
  const q = (p: number) => prices[Math.min(prices.length - 1, Math.floor(p * prices.length))];
  return { n: prices.length, p25: q(0.25), median: q(0.5), p75: q(0.75), examples: items.slice(0, 5).map((i) => ({ title: i.title, price: i.price, url: i.url })) };
}
