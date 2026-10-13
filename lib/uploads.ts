import { createHmac } from "node:crypto";
import { put } from "@vercel/blob";
import { config } from "./config";
import { detectOutfits } from "./detect";
import { tokenMatches, verify } from "./sign";
import { addGarmentRow, chooseOutfit, garmentRows, getTaste, saveTaste, type GarmentRow } from "./store";
import { emptyTaste, synthesizeTaste } from "./taste";

// The upload link carries its own key, derived from FITSCOUT_TOKEN. Leaking it only lets
// someone add photos, not use the connector. Hex only, so copying a link can't drop a
// trailing "_" or "-" (which is how the first version broke on a phone).
export const uploadKey = () => (config.token ? createHmac("sha256", config.token).update("upload").digest("hex").slice(0, 24) : "");
// Also accepts the first version's key, so a page opened from the old link keeps working.
export const uploadKeyOk = (key: string | null | undefined) => tokenMatches(key, uploadKey()) || verify("upload", key ?? "");
export const uploadLink = () => `${config.publicUrl}/u/${uploadKey()}`;
// The home-screen app (finds feed + notifications) lives behind the same key.
export const appUrl = () => `${config.publicUrl}/a/${uploadKey()}`;

export const MAX_UPLOAD_BYTES = 4_000_000;

export const PHOTO_PATH = /^inspo\/[\w.-]+\.jpg$/;

// Stores the photo privately, detects each person's outfit, and counts the main person's
// garments until the user taps someone else. `marked` is a copy with the user's face boxed,
// made on their phone; when present, the model is shown that copy instead.
export async function ingestPhoto(bytes: Buffer, contentType: string, original: string, marked: Buffer | null = null): Promise<GarmentRow> {
  const pathname = `inspo/${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 6)}.jpg`;
  const shown = marked ? `data:image/jpeg;base64,${marked.toString("base64")}` : `data:${contentType};base64,${bytes.toString("base64")}`;
  // Analyze first, so a photo the model can't read isn't left in storage.
  const { outfits, main } = await detectOutfits({ url: shown }, { marked: !!marked });
  await put(pathname, bytes, { access: "private", contentType, addRandomSuffix: false });
  const tagged = outfits.map((o) => ({ ...o, garments: o.garments.map((g) => ({ ...g, photo: pathname })) }));
  const found = !!marked && outfits.some((o) => o.main);
  const row: GarmentRow = { photo: pathname, original, garments: tagged[main]?.garments ?? [], outfits: tagged, chosen: main, found, at: new Date().toISOString() };
  await addGarmentRow(row);
  return row;
}

// What the upload page shows for a photo: who is in it and which one counts.
export const photoSummary = (row: GarmentRow) => ({
  photo: row.photo,
  garments: row.garments.map((g) => g.name),
  outfits: (row.outfits ?? []).map((o) => ({ position: o.position, outfit: o.outfit, garments: o.garments.map((g) => g.name) })),
  chosen: row.chosen ?? 0,
  found: !!row.found && (row.chosen ?? 0) === (row.outfits ?? []).findIndex((o) => o.main),
});

// Picks whose outfit counts in a photo (-1 for none). Returns that person's garments, or null if no such photo or person.
export async function pickOutfit(photo: string, index: number) {
  const row = (await garmentRows()).find((r) => r.photo === photo);
  if (!row?.outfits || index >= row.outfits.length) return null;
  await chooseOutfit(photo, index);
  return index < 0 ? [] : row.outfits[index].garments;
}

// The garments in their photos, deduped, for "they already have this" checks.
export const ownedFrom = (garments: { name: string }[]) => [...new Map(garments.map((g) => [g.name.toLowerCase(), g.name])).values()].slice(0, 200);

export async function buildProfileFromUploads() {
  const rows = (await garmentRows()).filter((r) => r.garments.length);
  const garments = rows.flatMap((r) => r.garments);
  if (!garments.length) throw new Error("No garments yet. Upload some photos first.");
  const { taste, costUsd } = await synthesizeTaste(garments, rows.length, await getTaste());
  taste.owned = ownedFrom(garments);
  await saveTaste(taste);
  return { taste, costUsd };
}

export async function uploadStats() {
  const [rows, taste] = await Promise.all([garmentRows(), getTaste()]);
  return {
    photos: rows.length,
    garments: rows.reduce((n, r) => n + r.garments.length, 0),
    builtFrom: taste?.photoCount ?? 0,
    groups: rows.filter((r) => (r.outfits?.length ?? 0) > 1).map(photoSummary),
    taste: taste ?? emptyTaste(),
  };
}

export async function saveDetails(input: {
  sizes?: { tops?: string; bottoms?: string; shoes?: string; baggy?: boolean };
  brands?: string[];
  budget?: { usualMax?: number; grailMax?: number };
  location?: { zip?: string; radiusMi?: number };
}) {
  const taste = (await getTaste()) ?? emptyTaste();
  const clean = <T extends object>(o: T | undefined) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined && v !== "" && !Number.isNaN(v)));
  taste.sizes = { ...taste.sizes, ...clean(input.sizes) };
  taste.budget = { ...taste.budget, ...clean(input.budget) };
  taste.location = { ...taste.location, ...clean(input.location) };
  if (input.brands) taste.myBrands = [...new Set(input.brands.map((b) => b.trim()).filter(Boolean))];
  taste.updatedAt = new Date().toISOString();
  await saveTaste(taste);
  return taste;
}
