import { config } from "./config";
import { structured, type ImageInput } from "./openai";
import { PARTS, type Garment, type Outfit } from "./types";

// Garment detection, adapted from tandpfun/wardrobe's importer: one strict-JSON vision call per
// photo. We drop the bounding boxes and cutouts and add the attributes a resale search cares about
// (era, fit, material, brand, how you'd search for it). Unlike wardrobe, items are grouped by person,
// because these photos are often group shots and only the user's own outfit should count.
const PROMPT = `This photo shows clothes someone likes: an outfit they wore (often with friends in frame), a fit they saved, or a screenshot. Catalog the clothes person by person.

List each person whose outfit is clearly visible, left to right, at most 6. Skip people who are mostly cut off, blurred, or far in the background. If no one is wearing the clothes (a flat lay, product shot, or hanger), return a single entry for the items shown.

For each person:
- position: where they are in the frame in a few words, e.g. "left", "center", "second from right", "back row". Use "no one" for a flat lay or product shot.
- outfit: up to 8 words on what they're wearing, enough to pick them out, e.g. "black leather jacket, light jeans".
- main: true for exactly one entry, the person the photo is about. In a selfie that's the person taking it; otherwise the most central, in-focus, and largest person.
- items: every distinct wearable clothing item or accessory they have on, one record per actual item.
Describe clothes only. Never identify anyone or describe faces or bodies.

For each item:
- name: a concise, specific resale-style name, e.g. "faded black boxy duck canvas work jacket".
- part: one of ${PARTS.join(", ")}.
- category: the garment type, e.g. "work jacket", "pleated trousers", "loafers".
- colorName and color (hex), plus secondaryColor (hex) only if there is a genuinely distinct second color.
- material, fit (silhouette), pattern, era (the style era or subculture it reads as, e.g. "90s workwear", "y2k", "japanese americana"): null when you cannot tell.
- brand: the maker, only if a logo, tag, or unmistakable signature design is visible; otherwise null. Never guess from vibe alone. A team, school, league, or band printed on it is not the brand: put that in tags.
- standout: true if it is a deliberate statement or signature piece, false for basics.
- tags: up to 6 short lowercase details (e.g. "double knee", "contrast stitching", "raw hem").
- queries: 1-3 search strings someone would type on Grailed, Depop, or eBay to find this item or close alternatives.`;

// Added when the phone matched the user's face and boxed it on the copy we're shown.
const MARKED = `

A bright green box has been drawn around one person's face. That person is the user: set main=true for them and no one else, and if you'd otherwise skip them, list them in place of someone else. The box is not part of the photo; ignore it when describing anything.`;

const nullableString = { type: ["string", "null"] };
const hex = { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" };

const ITEM = {
  type: "object",
  additionalProperties: false,
  required: ["name", "part", "category", "colorName", "color", "secondaryColor", "material", "fit", "pattern", "era", "brand", "standout", "tags", "queries"],
  properties: {
    name: { type: "string" },
    part: { type: "string", enum: [...PARTS] },
    category: { type: "string" },
    colorName: { type: "string" },
    color: hex,
    secondaryColor: { anyOf: [hex, { type: "null" }] },
    material: nullableString,
    fit: nullableString,
    pattern: nullableString,
    era: nullableString,
    brand: nullableString,
    standout: { type: "boolean" },
    tags: { type: "array", items: { type: "string" }, maxItems: 6 },
    queries: { type: "array", items: { type: "string" }, maxItems: 3 },
  },
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["people"],
  properties: {
    people: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["position", "outfit", "main", "items"],
        properties: {
          position: { type: "string" },
          outfit: { type: "string" },
          main: { type: "boolean" },
          items: { type: "array", maxItems: 10, items: ITEM },
        },
      },
    },
  },
};

// Everyone's outfit, plus the index of the person the photo is most likely about (the boxed
// person when `marked`).
export async function detectOutfits(image: ImageInput, { marked = false } = {}): Promise<{ outfits: Outfit[]; main: number; costUsd: number }> {
  const { data, costUsd } = await structured<{ people: { position: string; outfit: string; main: boolean; items: Garment[] }[] }>({
    model: config.models.vision,
    name: "outfits",
    schema: SCHEMA,
    text: marked ? PROMPT + MARKED : PROMPT,
    images: [{ detail: "high", ...image }],
    maxOutputTokens: 10_000,
  });
  const outfits = data.people.filter((p) => p.items.length).map(({ items, ...p }) => ({ ...p, garments: items }));
  return { outfits, main: Math.max(0, outfits.findIndex((o) => o.main)), costUsd };
}

// Just the main person's garments, for callers that can't ask whose outfit it is.
export async function detectGarments(image: ImageInput): Promise<{ garments: Garment[]; costUsd: number }> {
  const { outfits, main, costUsd } = await detectOutfits(image);
  return { garments: outfits[main]?.garments ?? [], costUsd };
}
