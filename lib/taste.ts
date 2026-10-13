import { config } from "./config";
import { structured } from "./openai";
import { PARTS, type Feedback, type Garment, type TasteProfile } from "./types";

export function emptyTaste(): TasteProfile {
  return {
    updatedAt: new Date().toISOString(),
    photoCount: 0,
    garmentCount: 0,
    brief: "",
    pillars: [],
    loves: { brands: [], colors: [], materials: [], fits: [], eras: [] },
    avoid: [],
    queries: [],
    exemplars: [],
    sizes: { tops: null, bottoms: null, shoes: null, notes: null },
    budget: { usualMax: 150, grailMax: 400 },
    location: { zip: null, radiusMi: 25 },
    notes: [],
    myBrands: [],
  };
}

function topValues(garments: Garment[], pick: (g: Garment) => string | null | undefined, n = 12) {
  const counts = new Map<string, number>();
  for (const g of garments) {
    const v = pick(g)?.trim().toLowerCase();
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([v, c]) => `${v} (${c})`);
}

const SYNTH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["brief", "pillars", "loves", "avoid", "queries", "exemplars"],
  properties: {
    brief: { type: "string" },
    pillars: {
      type: "array",
      minItems: 2,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description", "examples"],
        properties: { name: { type: "string" }, description: { type: "string" }, examples: { type: "array", items: { type: "string" }, maxItems: 5 } },
      },
    },
    loves: {
      type: "object",
      additionalProperties: false,
      required: ["brands", "colors", "materials", "fits", "eras"],
      properties: Object.fromEntries(["brands", "colors", "materials", "fits", "eras"].map((k) => [k, { type: "array", items: { type: "string" }, maxItems: 15 }])),
    },
    avoid: { type: "array", items: { type: "string" }, maxItems: 10 },
    queries: {
      type: "array",
      minItems: 10,
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["q", "part", "pillar"],
        properties: { q: { type: "string" }, part: { anyOf: [{ type: "string", enum: [...PARTS] }, { type: "null" }] }, pillar: { type: ["string", "null"] } },
      },
    },
    exemplars: { type: "array", items: { type: "string" }, maxItems: 40 },
  },
};

const SYNTH_PROMPT = `You are building a resale-shopping taste profile for one person from the garments detected in photos of clothes they like. Your profile will be used to (1) judge secondhand listings on eBay, Grailed, Depop, Poshmark, and Facebook Marketplace and (2) generate searches.

Write:
- brief: 120-180 words in second person describing their taste precisely enough that a stranger could shop for them. Name silhouettes, fabrics, palettes, eras, and what makes a piece "theirs" versus merely similar.
- pillars: the 2-6 distinct style directions in the photos, each with a name, a one-sentence description, and example garments.
- loves: the brands, colors, materials, fits, and eras that recur. Only include brands that were actually identified or that they listed themselves, and only clothing makers: a team, school, league, or band printed on a garment is not a brand they love.
- avoid: things conspicuously absent or that clash with the profile, phrased as listing red flags (e.g. "skinny fits", "loud logo-heavy streetwear"). Be conservative.
- queries: 20-40 resale searches for NEW pieces they'd want: inspired by the photos, never copies of the garments in them. They already have those. Search for their signature items in a new color, fabric, pattern, or era (e.g. "Polo Ralph Lauren cable knit quarter zip", not the black one they own) and for adjacent pieces that fit a pillar but aren't in their closet yet. 3-7 words each, brand or item first, in the words sellers put in titles; no "mens", sizes, or prices. Spread them across their pillars and garment parts.
- exemplars: up to 40 short descriptions of the most characteristic standout pieces.`;

export async function synthesizeTaste(garments: Garment[], photoCount: number, previous: TasteProfile | null) {
  const stats = [
    `Photos: ${photoCount}. Garments: ${garments.length}.`,
    `Parts: ${topValues(garments, (g) => g.part).join(", ")}`,
    `Categories: ${topValues(garments, (g) => g.category, 25).join(", ")}`,
    `Colors: ${topValues(garments, (g) => g.colorName, 15).join(", ")}`,
    `Materials: ${topValues(garments, (g) => g.material).join(", ")}`,
    `Fits: ${topValues(garments, (g) => g.fit).join(", ")}`,
    `Patterns: ${topValues(garments, (g) => g.pattern).join(", ")}`,
    `Eras: ${topValues(garments, (g) => g.era).join(", ")}`,
    `Brands seen: ${topValues(garments, (g) => g.brand, 30).join(", ") || "none legible"}`,
    previous?.myBrands?.length ? `Brands they say they wear or like (work these into loves.brands and the queries): ${previous.myBrands.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const list = garments
    .map((g) => `- ${g.standout ? "★ " : ""}${g.name} [${g.part}; ${[g.material, g.fit, g.era, ...g.tags].filter(Boolean).join(", ")}]`)
    .join("\n");

  const { data, costUsd } = await structured<Omit<TasteProfile, "updatedAt" | "photoCount" | "garmentCount" | "sizes" | "budget" | "location" | "notes">>({
    model: config.models.synth,
    name: "taste_profile",
    schema: SYNTH_SCHEMA,
    instructions: SYNTH_PROMPT,
    text: `${stats}\n\nAll garments (★ = standout piece):\n${list}`,
    effort: "medium",
    maxOutputTokens: 12000,
  });

  const base = previous ?? emptyTaste();
  const taste: TasteProfile = {
    ...base,
    ...data,
    updatedAt: new Date().toISOString(),
    photoCount,
    garmentCount: garments.length,
  };
  return { taste, costUsd };
}

// Sizes as the judge should read them: "L/XL" means either fits, and baggy bottoms run up to
// two waist sizes over.
export function renderSizes(s: TasteProfile["sizes"]) {
  const either = (v: string) => (/\/|,| or /i.test(v) ? `${v} (any of these fit)` : v);
  const parts: string[] = [];
  if (s.tops) parts.push(`tops ${either(s.tops)}`);
  if (s.bottoms) {
    const waist = Number(s.bottoms.match(/\d{2}/)?.[0]);
    if (!s.baggy) parts.push(`bottoms ${either(s.bottoms)}`);
    else if (waist) parts.push(`bottoms ${s.bottoms}, worn baggy: waist ${waist}, ${waist + 1}, or ${waist + 2} all fit (same length)`);
    else parts.push(`bottoms ${s.bottoms}, worn baggy: a size or two up also fits`);
  } else if (s.baggy) parts.push("bottoms worn baggy (sized up)");
  if (s.shoes) parts.push(`shoes ${either(s.shoes)}`);
  if (s.notes) parts.push(s.notes);
  return parts.join("; ");
}

// The text form of the profile that goes into prompts and back to Muse.
export function renderBrief(t: TasteProfile, opts: { forPrompt?: boolean } = {}) {
  const sizes = renderSizes(t.sizes);
  const lines = [
    t.brief || "(No taste profile yet: run the photo ingest.)",
    "",
    "Style pillars:",
    ...t.pillars.map((p) => `- ${p.name}: ${p.description}${p.examples.length ? ` (e.g. ${p.examples.slice(0, 3).join("; ")})` : ""}`),
    "",
    `Loves: brands ${t.loves.brands.join(", ") || "n/a"}; colors ${t.loves.colors.join(", ") || "n/a"}; materials ${t.loves.materials.join(", ") || "n/a"}; fits ${t.loves.fits.join(", ") || "n/a"}; eras ${t.loves.eras.join(", ") || "n/a"}.`,
    t.myBrands?.length ? `Brands they say they wear or like: ${t.myBrands.join(", ")}.` : "",
    t.avoid.length ? `Avoid: ${t.avoid.join("; ")}.` : "",
    `Sizes: ${sizes || "not set"}.`,
    `Budget: usually up to $${t.budget.usualMax}; up to $${t.budget.grailMax} for a grail.`,
    t.notes.length ? `Notes from them: ${t.notes.slice(-8).join(" | ")}` : "",
  ];
  if (opts.forPrompt && t.exemplars.length) lines.push("", "Characteristic pieces they own or love:", ...t.exemplars.slice(0, 25).map((e) => `- ${e}`));
  if (opts.forPrompt && t.owned?.length) lines.push("", `Already in their photos (they have these; a near-copy is not a find): ${t.owned.slice(0, 150).join("; ")}.`);
  return lines.filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n").trim();
}

export function renderFeedback(feedback: Feedback[]) {
  const fmt = (f: Feedback) => `- ${f.item ?? f.title}${f.price != null ? ` ($${f.price})` : ""}${f.note ? ` (their note: ${f.note})` : ""}`;
  const liked = feedback.filter((f) => f.rating !== "dislike").slice(0, 10);
  const disliked = feedback.filter((f) => f.rating === "dislike").slice(0, 10);
  if (!liked.length && !disliked.length) return "";
  return [
    liked.length ? `Recently liked or bought:\n${liked.map(fmt).join("\n")}` : "",
    disliked.length ? `Recently rejected (they did NOT want these, even though an earlier pass scored them well):\n${disliked.map(fmt).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
