// Judges listings from a JSON file against data/taste.json without touching the store.
// Usage: npm run judge:try -- listings.json   (an array of { url, title, price, images, source, size? })
import "./env";
import { readFileSync } from "node:fs";
import { judgeListing } from "../lib/judge";
import type { Listing, TasteProfile } from "../lib/types";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run judge:try -- listings.json");
  process.exit(1);
}
const taste = JSON.parse(readFileSync("data/taste.json", "utf8")) as TasteProfile;
const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Listing>[];
let total = 0;
for (const [i, l] of raw.entries()) {
  const listing: Listing = { id: `try:${i}`, source: "other", sourceId: String(i), currency: "USD", price: null, images: [], title: "", url: "", ...l };
  const { verdict, costUsd } = await judgeListing(listing, taste, [], process.argv.includes("--high") ? "high" : "low");
  total += costUsd;
  console.log(`${verdict.taste}/10  $${listing.price}  ${verdict.item}\n   ${verdict.why}${verdict.flags.length ? `\n   ⚠ ${verdict.flags.join(", ")}` : ""}${verdict.estValueUsd ? `\n   est. value $${verdict.estValueUsd}` : ""}`);
}
console.log(`\n~$${total.toFixed(4)}`);
