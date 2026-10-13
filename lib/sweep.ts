import { config } from "./config";
import { NoTasteProfile, notifyBest, processListings, type RunSummary } from "./pipeline";
import { ADAPTERS, enabledSources } from "./sources";
import { getHunt, getQueryStats, getTaste, listHunts, nextScoutQueries, oncePer, saveHunt, saveQueryStats, setHealth, type QueryStats } from "./store";
import { runTune } from "./tune";
import type { Find, Hunt, Listing, Source } from "./types";

type SourceStats = Partial<Record<Source, { count: number; error: string | null }>>;

async function searchAll(query: string, maxPrice: number | null, stats: SourceStats) {
  const found: Listing[] = [];
  for (const source of enabledSources()) {
    const stat = (stats[source] ??= { count: 0, error: null });
    try {
      const results = await ADAPTERS[source]!.search(query, { maxPrice, limit: config.sweep.perQuery });
      stat.count += results.length;
      found.push(...results);
    } catch (err) {
      stat.error = (err as Error).message;
    }
  }
  return [...new Map(found.map((l) => [l.id, l])).values()];
}

// Credits each judged find to the first search that surfaced it, so the tuning agent can see which
// searches earn their keep.
async function recordQueryStats(perQuery: Map<string, Listing[]>, finds: Find[], at: string) {
  const byId = new Map(finds.map((f) => [f.id, f]));
  const all = await getQueryStats();
  const credited = new Set<string>();
  const updates: Record<string, QueryStats> = {};
  for (const [q, listings] of perQuery) {
    const mine = listings.filter((l) => !credited.has(l.id) && byId.has(l.id)).map((l) => byId.get(l.id)!);
    listings.forEach((l) => credited.add(l.id));
    const scores = mine.map((f) => f.verdict?.taste ?? 0);
    const prev = all[q] ?? { runs: 0, found: 0, judged: 0, picks: 0, best: 0, lastRun: at, lastTop: [] };
    const top = [...mine].sort((a, b) => (b.verdict?.taste ?? 0) - (a.verdict?.taste ?? 0)).slice(0, 3).map((f) => `${f.verdict?.taste}/10 ${f.verdict?.item ?? f.title}`);
    updates[q] = {
      runs: prev.runs + 1,
      found: prev.found + listings.length,
      judged: prev.judged + mine.length,
      picks: prev.picks + scores.filter((s) => s >= 7).length,
      best: Math.max(prev.best, ...scores, 0),
      lastRun: at,
      lastTop: top.length ? top : prev.lastTop,
    };
  }
  await saveQueryStats(updates);
}

const brief = (r: RunSummary) => ({ received: r.received, alreadySeen: r.alreadySeen, judged: r.judged, candidates: r.candidates.length, dropped: r.dropped, stoppedEarly: r.stoppedEarly });

// One sweep: every active hunt, then a rotating slice of scout searches from the taste profile,
// then one batch of pushes with the best finds (hunt matches first). Run daily by cron, or on
// demand from the app. Throws NoTasteProfile before a profile exists.
export async function runSweep(via = "sweep") {
  const at = new Date().toISOString();
  const stats: SourceStats = {};
  try {
    const taste = await getTaste();
    if (!taste?.brief) throw new NoTasteProfile("No taste profile yet. Upload photos and build your profile first.");
    const hunts = (await listHunts()).filter((h) => h.active);
    const candidates = [];
    const huntRuns: Record<string, ReturnType<typeof brief>> = {};

    for (const hunt of hunts) {
      const listings = (await Promise.all(hunt.queries.map((q) => searchAll(q, hunt.maxPrice ? Math.round(hunt.maxPrice * 1.25) : null, stats)))).flat();
      const run = await processListings([...new Map(listings.map((l) => [l.id, l])).values()], via, hunt);
      candidates.push(...run.candidates);
      huntRuns[hunt.want] = brief(run);
      await saveHunt({ ...hunt, lastRunAt: at, matches: hunt.matches + run.candidates.length });
      if (run.stoppedEarly) break;
    }

    const queries = await nextScoutQueries(taste.queries.map((q) => q.q), config.sweep.scoutQueriesPerRun);
    const perQuery = new Map(await Promise.all(queries.map(async (q) => [q, await searchAll(q, taste.budget.grailMax, stats)] as const)));
    const scoutListings = [...perQuery.values()].flat();
    const scout = await processListings([...new Map(scoutListings.map((l) => [l.id, l])).values()], via);
    candidates.push(...scout.candidates);
    await recordQueryStats(perQuery, scout.finds, at);

    const pushed = await notifyBest(candidates, config.sweep.maxPushes, hunts);
    await Promise.all(
      (Object.entries(stats) as [Source, { count: number; error: string | null }][]).map(([source, s]) => setHealth(source, { ok: !s.error, at, count: s.count, error: s.error })),
    );
    const judged = scout.judged + Object.values(huntRuns).reduce((n, r) => n + r.judged, 0);
    await setHealth("sweep", { ok: true, at, count: judged, error: scout.stoppedEarly });
    return { sources: stats, hunts: huntRuns, scout: { queries, ...brief(scout) }, pushed };
  } catch (err) {
    const message = err instanceof NoTasteProfile ? err.message : `sweep failed: ${(err as Error).message}`;
    await setHealth("sweep", { ok: false, at, count: 0, error: message });
    throw err;
  }
}

// The morning routine (and "Scan now"): the tuning agent rewrites the searches first, at most
// every 6 hours, then the scan runs with them. A failed tune never blocks the scan.
export async function runDaily(via = "sweep") {
  let tune: Awaited<ReturnType<typeof runTune>> | { error: string } | null = null;
  if (await oncePer("tune", 6 * 3600)) {
    tune = await runTune({ budgetMs: 90_000 }).catch((err) => ({ error: (err as Error).message }));
  }
  const sweep = await runSweep(via);
  return { tune, ...sweep };
}

// One hunt, right now (when it's added in the app): search, judge against it, and notify about
// the best matches.
export async function runHunt(hunt: Hunt) {
  const stats: SourceStats = {};
  const listings = (await Promise.all(hunt.queries.map((q) => searchAll(q, hunt.maxPrice ? Math.round(hunt.maxPrice * 1.25) : null, stats)))).flat();
  const run = await processListings([...new Map(listings.map((l) => [l.id, l])).values()], "tracker", hunt);
  const pushed = await notifyBest(run.candidates, 3, [hunt]);
  // Re-read first: it may have been paused or removed while this ran.
  const latest = await getHunt(hunt.id);
  if (latest) await saveHunt({ ...latest, lastRunAt: new Date().toISOString(), matches: latest.matches + run.candidates.length });
  return { ...brief(run), pushed };
}
