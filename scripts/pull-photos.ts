// Mirrors photos uploaded from your phone into inspo/ and their detected garments into
// data/garments.jsonl (so `taste:ingest` won't re-analyze them). Usage: npm run photos:pull
import "./env";
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { get, list } from "@vercel/blob";
import { garmentRows, usingMemoryStore } from "../lib/store";

if (!process.env.BLOB_READ_WRITE_TOKEN || usingMemoryStore()) {
  console.error("Missing BLOB_READ_WRITE_TOKEN or KV_REST_API_URL in .env.local. Run `npx vercel env pull .env.local`.");
  process.exit(1);
}
mkdirSync("inspo", { recursive: true });
mkdirSync("data", { recursive: true });

let downloaded = 0;
let cursor: string | undefined;
do {
  const page = await list({ prefix: "inspo/", cursor });
  for (const blob of page.blobs) {
    const dest = join("inspo", basename(blob.pathname));
    if (existsSync(dest)) continue;
    const result = await get(blob.pathname, { access: "private" });
    if (!result?.stream) continue;
    writeFileSync(dest, Buffer.from(await new Response(result.stream).arrayBuffer()));
    downloaded++;
  }
  cursor = page.hasMore ? page.cursor : undefined;
} while (cursor);

const OUT = "data/garments.jsonl";
const have = new Set(existsSync(OUT) ? readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { photo: string }).photo) : []);
let rows = 0;
for (const row of await garmentRows()) {
  const photo = basename(row.photo);
  if (have.has(photo)) continue;
  appendFileSync(OUT, `${JSON.stringify({ photo, garments: row.garments.map((g) => ({ ...g, photo })) })}\n`);
  rows++;
}
console.log(`Downloaded ${downloaded} new photos to inspo/ and ${rows} garment rows to ${OUT}.`);
