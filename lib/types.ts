export const SOURCES = ["ebay", "grailed", "depop", "poshmark", "marketplace", "other"] as const;
export type Source = (typeof SOURCES)[number];

// A listing as it comes in, from a source adapter or from Muse's browser.
export interface Listing {
  id: string; // `${source}:${sourceId}`
  source: Source;
  sourceId: string;
  url: string;
  title: string;
  price: number | null;
  currency: string;
  images: string[];
  size?: string | null;
  brand?: string | null;
  condition?: string | null;
  description?: string | null;
  location?: string | null;
  listedAt?: string | null;
  endsAt?: string | null; // auctions
  bidCount?: number | null;
  format?: "fixed" | "auction" | null;
}

export interface Verdict {
  taste: number; // 0-10: how much this person would want it
  match: number | null; // 0-10: how exactly it is the item they're hunting for (hunts only)
  why: string;
  item: string; // what it actually is, in plain words
  brand: string | null;
  brandEvidence: "tag" | "logo" | "title" | "style" | null;
  sizeOk: "yes" | "no" | "unknown";
  pillar: string | null; // which of their style pillars it fits
  flags: string[]; // condition or authenticity concerns
  estValueUsd: number | null; // rough resale value, from the model
  model: string;
  detail: "low" | "high";
  judgedAt: string;
}

export type Rating = "like" | "dislike" | "bought";

export type Mode = "scout" | "hunt";

export interface Find extends Listing {
  mode: Mode; // scout: picked for their taste; hunt: matched something they asked for
  huntId?: string | null;
  firstSeen: string;
  via: string; // "sweep:ebay", "muse", ...
  verdict?: Verdict;
  dealRatio?: number | null; // price / value (sold comps when available, else the model's estimate); lower is better
  comps?: { source: "grailed sold"; query: string; n: number; p25: number; median: number; p75: number } | null;
  notified?: boolean;
  rating?: Rating | null;
}

export const PARTS = ["upperbody", "outerwear", "lowerbody", "fullbody", "shoes", "accessories"] as const;
export type Part = (typeof PARTS)[number];

// One garment pulled out of an inspiration photo.
export interface Garment {
  name: string;
  part: Part;
  category: string;
  colorName: string;
  color: string;
  secondaryColor: string | null;
  material: string | null;
  fit: string | null;
  pattern: string | null;
  era: string | null;
  brand: string | null;
  standout: boolean;
  tags: string[];
  queries: string[];
  photo?: string;
}

// One person's outfit in a photo, so a group shot only counts the clothes of the person who is you.
export interface Outfit {
  position: string; // "left", "second from right", "no one" for a flat lay
  outfit: string; // a few words on what they're wearing, to pick them out
  main: boolean; // the model's guess at who the photo is about
  garments: Garment[];
}

export interface StylePillar {
  name: string;
  description: string;
  examples: string[];
}

export interface TasteProfile {
  updatedAt: string;
  photoCount: number;
  garmentCount: number;
  brief: string;
  pillars: StylePillar[];
  loves: { brands: string[]; colors: string[]; materials: string[]; fits: string[]; eras: string[] };
  avoid: string[];
  queries: { q: string; part: Part | null; pillar: string | null }[];
  exemplars: string[]; // short descriptions of standout garments
  sizes: { tops: string | null; bottoms: string | null; shoes: string | null; notes: string | null; baggy?: boolean }; // baggy: bottoms up to 2 waist sizes over still fit
  budget: { usualMax: number; grailMax: number };
  location: { zip: string | null; radiusMi: number };
  notes: string[];
  myBrands?: string[]; // brands they say they wear or like; kept across profile rebuilds
  owned?: string[]; // garments in their photos: they have these, so a near-copy isn't a find
}

// A specific item they asked to find, e.g. "brown Carhartt Detroit jacket, blanket lined".
export interface Hunt {
  id: string;
  want: string;
  queries: string[];
  size: string | null;
  maxPrice: number | null;
  notes: string | null;
  active: boolean;
  createdAt: string;
  lastRunAt: string | null;
  matches: number;
  photo?: string | null; // their reference photo of the item, a small JPEG data URL
}

export interface Feedback {
  id: string;
  rating: Rating;
  title: string;
  item: string | null;
  why: string | null;
  price: number | null;
  note: string | null;
  at: string;
}
