import { config } from "./config";
import { structured } from "./openai";
import { renderBrief, renderFeedback } from "./taste";
import type { Feedback, Hunt, Listing, TasteProfile, Verdict } from "./types";

const INSTRUCTIONS = `You are a sharp personal shopper scouting secondhand clothing for exactly one person. Judge whether they would genuinely want THIS listing, from its photos first and text second.

Scoring (taste, 0-10):
- 9-10: unmistakably their taste and a piece they'd be excited to find.
- 7-8: clearly in their lane; worth showing them.
- 4-6: adjacent or generic; not worth a ping.
- 0-3: wrong style, wrong category, or junk.
They want NEW pieces inspired by their style, not copies of what they already have (listed under "Already in their photos"). A near-copy (the same kind of item in the same color and look, e.g. another black Polo quarter-zip when they have one) caps taste at 5; say so in why. Score highest for fresh takes in their lane: their kind of piece in a new color, fabric, pattern, era, or detail (e.g. a cream cable-knit Polo quarter-zip), or an adjacent piece that fits a pillar but isn't in their closet yet.

Be stingy. Most listings should land below 7. Penalize: wrong size when a size is given and theirs is known, poor condition, fast-fashion versions of a look they like, logo-forward versions when they lean understated, stock photos, and anything matching their "avoid" list or their recent rejections.

Also report:
- item: what it actually is in plain words, including the brand if you can tell.
- brand and brandEvidence: "tag" or "logo" only if visible in the photos; "title" if only the text says so; "style" if it's an unmistakable signature design; null if unknown. Sellers often mislabel or omit brands. If photos show a better brand than the title claims, say so in why.
- sizeOk: yes / no / unknown against their sizes. When they list several sizes (e.g. "L/XL") or a waist range, any of them is a yes.
- pillar: which of their style pillars it fits, or null.
- flags: short concerns (stains, holes, likely fake, reproduction, stock photo, wrong size).
- estValueUsd: your rough estimate of what this exact item typically resells for in this condition, or null if you can't tell.
- why: one sentence (under 25 words) written to them, saying what makes it them (or not).
- match: null, unless a HUNT is given below.`;

const HUNT_INSTRUCTIONS = `They are HUNTING for a specific item, described below. Score match (0-10) for how exactly this listing is that item:
- 10: exactly what they described (model, color, details), in their size.
- 8-9: the item with a minor difference they'd almost certainly accept.
- 5-7: a close variant or a different colorway/generation.
- 0-4: a different item that just shares keywords.
Wrong size (when known) caps match at 4. Reproductions and fakes cap match at 2. In why, say plainly whether this is the thing they're hunting and what differs. Still score taste as usual.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["taste", "match", "why", "item", "brand", "brandEvidence", "sizeOk", "pillar", "flags", "estValueUsd"],
  properties: {
    taste: { type: "number", minimum: 0, maximum: 10 },
    why: { type: "string" },
    item: { type: "string" },
    brand: { type: ["string", "null"] },
    brandEvidence: { anyOf: [{ type: "string", enum: ["tag", "logo", "title", "style"] }, { type: "null" }] },
    sizeOk: { type: "string", enum: ["yes", "no", "unknown"] },
    pillar: { type: ["string", "null"] },
    flags: { type: "array", items: { type: "string" }, maxItems: 6 },
    estValueUsd: { type: ["number", "null"] },
    match: { type: ["number", "null"], minimum: 0, maximum: 10 },
  },
};

export function describeListing(l: Listing) {
  return [
    `Source: ${l.source}`,
    `Title: ${l.title}`,
    `Price: ${l.price != null ? `${l.currency === "USD" ? "$" : `${l.currency} `}${l.price}` : "unknown"}${l.format === "auction" ? ` (auction${l.bidCount != null ? `, ${l.bidCount} bids` : ""}${l.endsAt ? `, ends ${l.endsAt}` : ""})` : ""}`,
    l.size ? `Size: ${l.size}` : "",
    l.brand ? `Brand (as listed): ${l.brand}` : "",
    l.condition ? `Condition: ${l.condition}` : "",
    l.location ? `Location: ${l.location}` : "",
    l.description ? `Description: ${l.description.slice(0, 800)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function describeHunt(h: Hunt) {
  return [`Hunting for: ${h.want}`, h.size ? `Size: ${h.size}` : "", h.maxPrice ? `Max price: $${h.maxPrice}` : "", h.notes ? `Notes: ${h.notes}` : ""].filter(Boolean).join("\n");
}

export async function judgeListing(listing: Listing, taste: TasteProfile, feedback: Feedback[], detail: "low" | "high" = "low", hunt: Hunt | null = null) {
  const listingImages = listing.images.slice(0, detail === "high" ? 6 : 2).map((url) => ({ url, detail }));
  // Their own photo of the item they're hunting goes first, so the judge can compare by eye.
  const reference = hunt?.photo ? [{ url: hunt.photo, detail: "low" as const }] : [];
  const images = [...reference, ...listingImages];
  const text = [
    "THE PERSON:",
    renderBrief(taste, { forPrompt: true }),
    renderFeedback(feedback),
    hunt ? `\nTHE HUNT:\n${describeHunt(hunt)}` : "",
    "",
    "THE LISTING:",
    describeListing(listing),
    reference.length ? "(The first image is THEIR photo of the item they're hunting. Compare the listing's photos against it.)" : "",
    listingImages.length ? `(${listingImages.length} listing photo${listingImages.length > 1 ? "s" : ""} attached)` : "(no listing photos available; judge from text and be conservative)",
  ]
    .filter((s) => s !== "")
    .join("\n");

  const { data, costUsd } = await structured<Omit<Verdict, "model" | "detail" | "judgedAt">>({
    model: config.models.judge,
    name: "verdict",
    schema: SCHEMA,
    instructions: hunt ? `${INSTRUCTIONS}\n\n${HUNT_INSTRUCTIONS}` : INSTRUCTIONS,
    text,
    images,
    effort: detail === "high" ? "medium" : "low",
    maxOutputTokens: 3000,
  });
  const round = (n: number) => Math.round(n * 10) / 10;
  const verdict: Verdict = { ...data, taste: round(data.taste), match: hunt && data.match != null ? round(data.match) : null, model: config.models.judge, detail, judgedAt: new Date().toISOString() };
  return { verdict, costUsd };
}
