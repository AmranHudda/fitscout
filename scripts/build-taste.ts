// Turns data/garments.jsonl into a taste profile at data/taste.json.
// Sizes, budget, and location come from data/me.json if present (see README), else the previous profile.
import "./env";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { renderBrief, synthesizeTaste } from "../lib/taste";
import type { Garment, TasteProfile } from "../lib/types";

if (!existsSync("data/garments.jsonl")) {
  console.error("No data/garments.jsonl yet. Run npm run taste:ingest first.");
  process.exit(1);
}
const rows = readFileSync("data/garments.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { photo: string; garments: Garment[] });
const garments = rows.flatMap((r) => r.garments);
const previous: TasteProfile | null = existsSync("data/taste.json") ? JSON.parse(readFileSync("data/taste.json", "utf8")) : null;

const { taste, costUsd } = await synthesizeTaste(garments, rows.length, previous);
if (existsSync("data/me.json")) {
  const me = JSON.parse(readFileSync("data/me.json", "utf8")) as Partial<Pick<TasteProfile, "sizes" | "budget" | "location">>;
  taste.sizes = { ...taste.sizes, ...me.sizes };
  taste.budget = { ...taste.budget, ...me.budget };
  taste.location = { ...taste.location, ...me.location };
}
writeFileSync("data/taste.json", `${JSON.stringify(taste, null, 2)}\n`);
console.log(`${renderBrief(taste, { forPrompt: true })}\n\nSearches:\n${taste.queries.map((q) => `- ${q.q}`).join("\n")}`);
console.log(`\nWrote data/taste.json from ${garments.length} garments in ${rows.length} photos (~$${costUsd.toFixed(3)}). Next: npm run taste:push`);
