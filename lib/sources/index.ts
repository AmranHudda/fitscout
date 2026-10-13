import type { Listing, Source } from "../types";
import { ebayEnabled, searchEbay } from "./ebay";
import { searchGrailed } from "./grailed";

export interface SourceAdapter {
  enabled: () => boolean;
  search: (query: string, opts: { maxPrice?: number | null; limit?: number }) => Promise<Listing[]>;
}

// FITSCOUT_SOURCES turns server-side sources on or off (default: all that are configured).
const allowed = () => new Set((process.env.FITSCOUT_SOURCES ?? "ebay,grailed").split(",").map((s) => s.trim()));

// Server-side sweeps: eBay's official API and Grailed's public search index. Facebook Marketplace
// and sites that disallow automated search (Poshmark's robots.txt blocks /search; Depop sits behind
// bot protection) come in through Muse, which browses them as you and calls judge_listings.
export const ADAPTERS: Partial<Record<Source, SourceAdapter>> = {
  ebay: { enabled: () => allowed().has("ebay") && ebayEnabled(), search: searchEbay },
  grailed: { enabled: () => allowed().has("grailed"), search: searchGrailed },
};

export const enabledSources = () => (Object.keys(ADAPTERS) as Source[]).filter((s) => ADAPTERS[s]!.enabled());
