// Uploads data/taste.json to the deployed store. Scout searches come from it directly.
// Keeps sizes, budget, location, and notes already set through Muse unless --overwrite is passed.
import "./env";
import { readFileSync } from "node:fs";
import { getTaste, saveTaste, usingMemoryStore } from "../lib/store";
import type { TasteProfile } from "../lib/types";

if (usingMemoryStore()) {
  console.error("No KV_REST_API_URL / KV_REST_API_TOKEN in .env.local. Run `npx vercel env pull .env.local` after adding Upstash.");
  process.exit(1);
}
const local = JSON.parse(readFileSync("data/taste.json", "utf8")) as TasteProfile;
const remote = await getTaste();
const taste =
  remote && !process.argv.includes("--overwrite")
    ? { ...local, sizes: remote.sizes, budget: remote.budget, location: remote.location, notes: [...new Set([...remote.notes, ...local.notes])] }
    : local;
await saveTaste(taste);
console.log(`Pushed taste profile: ${taste.garmentCount} garments, ${taste.queries.length} scout searches.`);
