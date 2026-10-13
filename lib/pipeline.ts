import { config } from "./config";
import { judgeListing } from "./judge";
import { push, pushText } from "./notify";
import { BudgetExceeded } from "./openai";
import { grailedSoldComps } from "./sources/grailed";
import { countJudge, getFind, getTaste, markSeen, onceToday, recentFeedback, saveFind, unmarkSeen } from "./store";
import type { Find, Hunt, Listing, TasteProfile, Verdict } from "./types";

export class NoTasteProfile extends Error {}

// What a find is ranked by: how exactly it matches a hunt, or how much it fits their taste.
export const score = (f: Pick<Find, "mode" | "verdict">) => (f.mode === "hunt" ? (f.verdict?.match ?? 0) : (f.verdict?.taste ?? 0));

// Cheap checks before spending a model call. Returns why a listing is dropped, or null to keep it.
export function prefilter(listing: Listing, taste: TasteProfile, hunt: Hunt | null = null): string | null {
  if (!listing.title?.trim()) return "no title";
  // Hunts allow some room over the max for offers; scouting stops at the grail budget.
  const cap = hunt ? (hunt.maxPrice ? hunt.maxPrice * 1.25 : null) : taste.budget.grailMax;
  if (listing.price != null && cap != null && listing.price > cap) return hunt ? "over hunt budget" : "over grail budget";
  return null;
}

// Price over value: real sold comps when we have them, else the model's estimate.
export function dealRatio(price: number | null, verdict: Verdict, compsMedian: number | null = null) {
  const value = compsMedian ?? verdict.estValueUsd;
  if (price == null || !value || value <= 0) return null;
  return Math.round((price / value) * 100) / 100;
}

async function soldComps(verdict: Verdict) {
  try {
    const comps = await grailedSoldComps([verdict.brand, verdict.item].filter(Boolean).join(" "));
    return comps && { source: comps.source, query: comps.query, n: comps.n, p25: comps.p25, median: comps.median, p75: comps.p75 };
  } catch {
    return null;
  }
}

export function shouldNotify(find: Find, taste: TasteProfile, hunt: Hunt | null = null, rules = config.notify) {
  const v = find.verdict;
  if (!v || v.sizeOk === "no") return false;
  if (find.mode === "hunt") {
    if (hunt?.maxPrice && find.price != null && find.price > hunt.maxPrice) return false;
    return (v.match ?? 0) >= rules.huntMinMatch;
  }
  // Above the usual budget only a near-perfect piece is worth interrupting for.
  if (find.price != null && find.price > taste.budget.usualMax && v.taste < 9) return false;
  if (v.taste >= rules.minTaste) return true;
  return v.taste >= rules.dealMinTaste && find.dealRatio != null && find.dealRatio <= rules.dealRatio;
}

export interface RunSummary {
  received: number;
  alreadySeen: number;
  dropped: Record<string, number>;
  judged: number;
  stoppedEarly: string | null;
  finds: Find[];
  candidates: Find[]; // passed the notify rule; pushed later by notifyBest
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

// Dedupes, prefilters, and judges listings as scout picks, or against one hunt.
export async function processListings(listings: Listing[], via: string, hunt: Hunt | null = null): Promise<RunSummary> {
  const taste = await getTaste();
  if (!taste?.brief) throw new NoTasteProfile("No taste profile yet. Run `npm run taste:ingest` and `npm run taste:build`, then `npm run taste:push`.");
  const feedback = await recentFeedback(30);
  const scope = hunt?.id ?? "scout";
  const summary: RunSummary = { received: listings.length, alreadySeen: 0, dropped: {}, judged: 0, stoppedEarly: null, finds: [], candidates: [] };

  await mapLimit(listings, 4, async (listing) => {
    if (summary.stoppedEarly) return;
    if (!(await markSeen(listing.id, scope))) {
      summary.alreadySeen++;
      const existing = await getFind(listing.id);
      if (existing && via === "muse") summary.finds.push(existing);
      return;
    }
    const drop = prefilter(listing, taste, hunt);
    if (drop) {
      summary.dropped[drop] = (summary.dropped[drop] ?? 0) + 1;
      return;
    }
    if ((await countJudge()) > config.maxJudgesPerDay) {
      summary.stoppedEarly = `daily judge limit (${config.maxJudgesPerDay}) reached`;
      await unmarkSeen(listing.id, scope);
      return;
    }
    try {
      const mode = hunt ? "hunt" : "scout";
      let { verdict } = await judgeListing(listing, taste, feedback, "low", hunt);
      // Second, closer look (more photos, high detail) for anything that might be worth a ping.
      if (score({ mode, verdict }) >= config.escalateAt && listing.images.length) ({ verdict } = await judgeListing(listing, taste, feedback, "high", hunt));
      summary.judged++;
      // Only worth a comps lookup when it might be pinged.
      const comps = score({ mode, verdict }) >= config.escalateAt ? await soldComps(verdict) : null;
      // Inline images were only for the model; keep stored finds small.
      const find: Find = {
        ...listing,
        images: listing.images.filter((u) => !u.startsWith("data:")),
        mode,
        huntId: hunt?.id ?? null,
        firstSeen: new Date().toISOString(),
        via,
        verdict,
        dealRatio: dealRatio(listing.price, verdict, comps?.median ?? null),
        comps,
        notified: false,
        rating: null,
      };
      await saveFind(find);
      summary.finds.push(find);
      if (shouldNotify(find, taste, hunt)) summary.candidates.push(find);
    } catch (err) {
      await unmarkSeen(listing.id, scope);
      if (err instanceof BudgetExceeded) {
        summary.stoppedEarly = err.message;
        if (await onceToday("budget-alert")) await pushText("fitscout paused", `${err.message}. Judging resumes tomorrow.`);
        return;
      }
      summary.dropped["judge error"] = (summary.dropped["judge error"] ?? 0) + 1;
      console.error(`judge failed for ${listing.id}:`, err);
    }
  });

  summary.finds.sort((a, b) => score(b) - score(a));
  return summary;
}

// Pushes the best candidates (hunt matches first), at most `limit`, and marks them notified.
export async function notifyBest(candidates: Find[], limit: number, hunts: Hunt[] = []) {
  const ranked = [...new Map(candidates.map((f) => [f.id, f])).values()].sort(
    (a, b) => Number(b.mode === "hunt") - Number(a.mode === "hunt") || score(b) - score(a),
  );
  let sent = 0;
  for (const find of ranked.slice(0, limit)) {
    const hunt = hunts.find((h) => h.id === find.huntId) ?? null;
    if (await push(find, hunt)) {
      find.notified = true;
      await saveFind(find);
      sent++;
    }
  }
  return sent;
}
