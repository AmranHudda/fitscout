import { config } from "./config";
import { runAgent, type AgentTool } from "./openai";
import { searchGrailed } from "./sources/grailed";
import { addTuneLog, getQueryStats, getTaste, recentFeedback, saveTaste, type TuneChange } from "./store";
import { renderBrief } from "./taste";
import { PARTS } from "./types";

// The tuning agent. Before each morning scan it reviews how every search did and what they
// rated, test-runs candidate searches on Grailed, and rewrites the search list. It can only
// change searches and the avoid list; it never touches sizes, budget, or anything outside fitscout.
const INSTRUCTIONS = `You maintain the resale searches for one person's clothing scout. Each morning, before the scan, you improve their search list so tomorrow's scan surfaces more pieces they'd actually want.

Work like this:
1. Call search_stats and recent_ratings to see which searches found good listings, which found nothing or junk, and what they liked or rejected.
2. Test before you change: preview_search runs a search on Grailed and shows what comes back. A good search returns several listings whose titles match the target item. Preview any search you plan to add, and suspicious existing ones (never run, or mostly junk).
3. Make changes with replace_search, add_search, remove_search, and add_avoid. Each needs a short reason.

Rules:
- Searches are 3-7 words, brand or item first, the words sellers put in titles. No "mens", sizes, or prices.
- They want new pieces, not copies of what's in their photos (listed in the profile). Replace searches that would mostly return near-copies with variations (a new color, fabric, era, or detail) or adjacent pieces.
- Replace searches that return nothing or mostly the wrong item. Remove near-duplicates. Add searches inspired by things they rated 👍, staying inside their style pillars.
- Only add an avoid rule when two or more 👎 share a clear reason.
- At most 6 changes. If the list is working, change nothing; that's a fine outcome.
- Finish by replying in plain text: 1-3 sentences to them saying what you changed and why, or that you left things alone.`;

const strict = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const str = { type: "string" };

export async function runTune({ budgetMs = 100_000 } = {}) {
  const taste = await getTaste();
  if (!taste?.brief) throw new Error("No taste profile yet.");
  const [stats, feedback] = await Promise.all([getQueryStats(), recentFeedback(30)]);
  const queries = taste.queries.map((q) => ({ ...q }));
  const avoid = [...taste.avoid];
  const changes: TuneChange[] = [];
  let previews = 0;
  const has = (q: string) => queries.some((x) => x.q.toLowerCase() === q.trim().toLowerCase());
  const limit = () => (changes.length >= 6 ? { error: "Change limit reached. Finish now." } : null);

  const tools: AgentTool[] = [
    {
      name: "search_stats",
      description: "Every current search with how it has done in past scans (runs, listings found, judged, picks scoring 7+, best score, recent top items). Searches never run yet show runs: 0.",
      parameters: strict({}),
      run: async () => queries.map((q) => ({ search: q.q, pillar: q.pillar, part: q.part, ...(stats[q.q] ?? { runs: 0 }) })),
    },
    {
      name: "recent_ratings",
      description: "Their latest 👍/👎 ratings on finds, newest first.",
      parameters: strict({}),
      run: async () => feedback.map((f) => ({ rating: f.rating === "dislike" ? "👎" : "👍", item: f.item ?? f.title, price: f.price, whyItWasShown: f.why, note: f.note })),
    },
    {
      name: "preview_search",
      description: "Run a search on Grailed right now (within their grail budget) and see how many listings come back and their titles.",
      parameters: strict({ query: str }),
      run: async ({ query }) => {
        if (previews >= 10) return { error: "Preview limit reached." };
        previews++;
        const found = await searchGrailed(String(query), { maxPrice: taste.budget.grailMax, limit: 12 });
        return { count: found.length, titles: found.map((l) => `${l.title} ($${l.price})`) };
      },
    },
    {
      name: "replace_search",
      description: "Swap an existing search for a better one.",
      parameters: strict({ old: str, new: str, reason: str }),
      run: async ({ old, new: next, reason }) => {
        const i = queries.findIndex((q) => q.q === old);
        if (i < 0) return { error: `No search "${old}".` };
        if (has(String(next))) return { error: "That search already exists." };
        const stop = limit();
        if (stop) return stop;
        changes.push({ action: "replace", query: String(next), replaced: String(old), reason: String(reason) });
        queries[i] = { ...queries[i], q: String(next).trim() };
        return { ok: true };
      },
    },
    {
      name: "add_search",
      description: "Add a new search under one of their style pillars.",
      parameters: strict({ query: str, pillar: str, part: { type: "string", enum: [...PARTS] }, reason: str }),
      run: async ({ query, pillar, part, reason }) => {
        if (has(String(query))) return { error: "That search already exists." };
        if (queries.length >= 45) return { error: "Too many searches; replace or remove one instead." };
        const stop = limit();
        if (stop) return stop;
        changes.push({ action: "add", query: String(query), reason: String(reason) });
        queries.push({ q: String(query).trim(), pillar: String(pillar), part: part as (typeof PARTS)[number] });
        return { ok: true };
      },
    },
    {
      name: "remove_search",
      description: "Drop a search that isn't earning its place.",
      parameters: strict({ query: str, reason: str }),
      run: async ({ query, reason }) => {
        const i = queries.findIndex((q) => q.q === query);
        if (i < 0) return { error: `No search "${query}".` };
        if (queries.length <= 15) return { error: "Keep at least 15 searches; replace instead." };
        const stop = limit();
        if (stop) return stop;
        changes.push({ action: "remove", query: String(query), reason: String(reason) });
        queries.splice(i, 1);
        return { ok: true };
      },
    },
    {
      name: "add_avoid",
      description: "Add something to their avoid list, when several 👎 share a reason.",
      parameters: strict({ rule: str, reason: str }),
      run: async ({ rule, reason }) => {
        const stop = limit();
        if (stop) return stop;
        changes.push({ action: "avoid", query: String(rule), reason: String(reason) });
        avoid.push(String(rule));
        return { ok: true };
      },
    },
  ];

  const { output, costUsd } = await runAgent({
    model: config.models.synth,
    instructions: INSTRUCTIONS,
    input: `Their profile:\n${renderBrief(taste, { forPrompt: true })}\n\nToday is ${new Date().toISOString().slice(0, 10)}. Review and improve their searches.`,
    tools,
    maxSteps: 20,
    deadline: Date.now() + budgetMs,
    effort: "low",
  });

  if (changes.length) {
    const latest = (await getTaste()) ?? taste; // keep anything saved while the agent worked
    latest.queries = queries;
    latest.avoid = [...new Set(avoid)];
    latest.updatedAt = new Date().toISOString();
    await saveTaste(latest);
  }
  const entry = { at: new Date().toISOString(), summary: output, changes, previews, costUsd };
  await addTuneLog(entry);
  return entry;
}
