import { config } from "./config";
import { structured } from "./openai";
import type { Hunt } from "./types";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["queries"],
  properties: { queries: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4 } },
};

// Turns "the brown Carhartt Detroit jacket, blanket lined" into 2-4 resale search strings:
// one exact, the rest catching how sellers actually title it (misspellings, model codes, era words).
export async function planQueries(want: string) {
  const { data } = await structured<{ queries: string[] }>({
    model: config.models.judge,
    name: "hunt_queries",
    schema: SCHEMA,
    text: `Someone is hunting for this secondhand item: "${want}". Write 2-4 resale search queries (eBay, Grailed) that would surface it, from most exact to broader. Use the words sellers actually put in titles (brand, model name or code, key detail, color). Never include size or price in the query.`,
    effort: "low",
    maxOutputTokens: 1000,
  });
  return data.queries;
}

const PHOTO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["want", "details", "queries"],
  properties: {
    want: { type: "string" },
    details: { type: "string" },
    queries: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4 },
  },
};

// A hunt from a photo: names the item precisely and lists what tells it apart, so the judge
// can check listings against it.
export async function describeHuntPhoto(photo: string, words: string) {
  const { data } = await structured<{ want: string; details: string; queries: string[] }>({
    model: config.models.vision,
    name: "hunt_from_photo",
    schema: PHOTO_SCHEMA,
    text: `Someone wants to buy this item secondhand.${words ? ` In their words: "${words}".` : ""} From the photo (and their words, which win if they conflict):
- want: one line naming it the way a reseller would: brand, model or line, garment type, color, material.
- details: the visible details that tell this exact item apart from look-alikes (logo placement, collar, closure, pattern, hardware).
- queries: 2-4 resale search queries (eBay, Grailed), most exact first, in the words sellers put in titles. No size or price.`,
    images: [{ url: photo, detail: "high" }],
    effort: "low",
    maxOutputTokens: 1500,
  });
  return data;
}

export async function newHunt(input: { want: string; queries?: string[]; size?: string | null; maxPrice?: number | null; notes?: string | null; photo?: string | null }): Promise<Hunt> {
  const fromPhoto = input.photo && !input.queries?.length ? await describeHuntPhoto(input.photo, input.want) : null;
  return {
    id: crypto.randomUUID().slice(0, 8),
    want: input.want || fromPhoto?.want || "item from photo",
    queries: input.queries?.length ? input.queries.slice(0, 4) : (fromPhoto?.queries ?? (await planQueries(input.want))),
    size: input.size ?? null,
    maxPrice: input.maxPrice ?? null,
    notes: [fromPhoto ? `From their photo: ${fromPhoto.want}. ${fromPhoto.details}` : "", input.notes ?? ""].filter(Boolean).join(" ") || null,
    photo: input.photo ?? null,
    active: true,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    matches: 0,
  };
}
