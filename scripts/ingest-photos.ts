// Detects the garments in your inspiration photos (in group shots, only the main person's) and appends them to data/garments.jsonl.
// Usage: npm run taste:ingest -- [folder]   (default: inspo/). Safe to re-run; done photos are skipped.
import "./env";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { detectGarments } from "../lib/detect";
import type { Garment } from "../lib/types";

const dir = process.argv[2] ?? "inspo";
const OUT = "data/garments.jsonl";
const IMAGE = /\.(jpe?g|png|heic|heif|webp|tiff?|avif)$/i;

mkdirSync("data", { recursive: true });
const done = new Set(
  existsSync(OUT)
    ? readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { photo: string }).photo)
    : [],
);
const photos = readdirSync(dir).filter((f) => IMAGE.test(f) && !done.has(f)).sort();
if (!photos.length) {
  console.log(done.size ? `All ${done.size} photos already processed.` : `No photos found in ${dir}/.`);
  process.exit(0);
}
console.log(`${photos.length} new photos (${done.size} already done).`);

const work = mkdtempSync(join(tmpdir(), "fitscout-"));

// Upright JPEG, long edge 1600px. sips ships with macOS and reads HEIC.
function toJpeg(file: string) {
  const out = join(work, `${file}.jpg`);
  try {
    execFileSync("sips", ["-s", "format", "jpeg", "-Z", "1600", join(dir, file), "--out", out], { stdio: "ignore" });
    return readFileSync(out);
  } catch {
    if (/\.(jpe?g|png|webp)$/i.test(extname(file))) return readFileSync(join(dir, file));
    throw new Error("could not convert (sips unavailable?)");
  }
}

let cost = 0;
let garments = 0;
let failed = 0;
let next = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (next < photos.length) {
      const i = next++;
      const photo = photos[i];
      try {
        const jpeg = toJpeg(photo);
        const result = await detectGarments({ url: `data:image/jpeg;base64,${jpeg.toString("base64")}` });
        const items: Garment[] = result.garments.map((g) => ({ ...g, photo }));
        appendFileSync(OUT, `${JSON.stringify({ photo, garments: items })}\n`);
        cost += result.costUsd;
        garments += items.length;
        console.log(`[${i + 1}/${photos.length}] ${photo}: ${items.map((g) => g.name).join("; ") || "(no clothing found)"}`);
      } catch (err) {
        failed++;
        console.error(`[${i + 1}/${photos.length}] ${photo}: FAILED ${(err as Error).message}`);
      }
    }
  }),
);
rmSync(work, { recursive: true, force: true });
console.log(`\nDone: ${garments} garments from ${photos.length - failed} photos, ${failed} failed, ~$${cost.toFixed(3)}. Next: npm run taste:build`);
