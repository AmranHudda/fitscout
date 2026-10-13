import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { config } from "./config";
import { detectGarments } from "./detect";
import { newHunt } from "./hunts";
import { NoTasteProfile, notifyBest, processListings, score } from "./pipeline";
import { enabledSources } from "./sources";
import { ebayAskingComps, ebayEnabled } from "./sources/ebay";
import { grailedSoldComps } from "./sources/grailed";
import { runTune } from "./tune";
import {
  getFind,
  getHealth,
  getHunt,
  getTaste,
  listHunts,
  rateFind,
  recentFinds,
  removeHunt,
  saveHunt,
  saveTaste,
  usageToday,
  usingMemoryStore,
} from "./store";
import { emptyTaste, renderBrief } from "./taste";
import { SOURCES, type Find, type Hunt, type Listing } from "./types";

export const SERVER_INSTRUCTIONS = `fitscout is this person's clothing scout. It has two sections:
- Scout: finds pieces it thinks they'll like, judged against a taste profile learned from ~100 photos of clothes they love.
- Hunt: looks for specific items they've asked for ("the brown Carhartt Detroit jacket, size M, under $120").
Every morning a tuning agent rewrites its searches from what worked and what they rated, then it searches Grailed (and eBay when configured) for both sections and pushes the best finds to their home-screen app.

How to use it:
- Before searching anywhere for clothes for them, call get_taste_brief. It includes their active hunts.
- When they say they want a specific item, add it with hunts (action "add").
- When you browse Facebook Marketplace, Depop, Grailed, Poshmark, or any shop for them, send every plausible candidate to judge_listings (batch up to 20). Pass huntId when you were searching for one of their hunts. Only surface scout picks scoring 7+ and hunt matches scoring 8+.
- When they react to a find ("love it", "not for me", "bought it"), call rate_find so it learns.
- If they say the finds are off, or after a batch of ratings, call tune_searches to rewrite the searches.
- Never message a seller, make an offer, or buy anything without their explicit approval for that specific action. draft_offer only drafts text.`;

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] });
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

const brief = (f: Find) => ({
  id: f.id,
  section: f.mode,
  huntId: f.huntId ?? null,
  taste: f.verdict?.taste ?? null,
  match: f.verdict?.match ?? null,
  item: f.verdict?.item ?? f.title,
  why: f.verdict?.why ?? null,
  price: f.price,
  size: f.size ?? null,
  source: f.source,
  dealRatio: f.dealRatio ?? null,
  soldMedian: f.comps?.median ?? null,
  flags: f.verdict?.flags ?? [],
  url: f.url,
  image: f.images.find((u) => !u.startsWith("data:")) ?? null,
  seen: f.firstSeen,
  rating: f.rating ?? null,
});

const listingInput = z.object({
  url: z.string().url().describe("Link to the listing"),
  title: z.string().min(1),
  price: z.number().nullable().describe("Price in USD, or null if unknown"),
  images: z.array(z.string().url()).max(8).describe("Direct image URLs from the listing, best photo first"),
  source: z.enum(SOURCES).describe("Where it was found"),
  size: z.string().nullish(),
  brand: z.string().nullish(),
  condition: z.string().nullish(),
  description: z.string().max(2000).nullish(),
  location: z.string().nullish().describe("Neighborhood or city for local pickup listings"),
});

function toListing(input: z.infer<typeof listingInput>): Listing {
  const url = new URL(input.url);
  const sourceId = `${url.hostname.replace(/^www\./, "")}${url.pathname}`.replace(/\/$/, "");
  return {
    id: `${input.source}:${sourceId}`,
    source: input.source,
    sourceId,
    url: input.url,
    title: input.title,
    price: input.price,
    currency: "USD",
    images: input.images,
    size: input.size ?? null,
    brand: input.brand ?? null,
    condition: input.condition ?? null,
    description: input.description ?? null,
    location: input.location ?? null,
    format: "fixed",
  };
}

export function registerTools(server: McpServer) {
  server.registerTool(
    "get_taste_brief",
    {
      title: "Get taste brief",
      description: "Their style profile, sizes, budget, and location as text. Read this before shopping for them or setting up a Facebook Marketplace watch.",
      inputSchema: z.object({}),
    },
    async () => {
      const taste = await getTaste();
      if (!taste) return text("No taste profile yet. Ask them to run the photo ingest (see the fitscout README).");
      const loc = taste.location.zip ? `Local pickup area: within ${taste.location.radiusMi} miles of ${taste.location.zip}.` : "Local pickup area: not set.";
      const hunts = (await listHunts()).filter((h) => h.active);
      const huntLines = hunts.length
        ? hunts.map((h) => `- [${h.id}] ${h.want}${h.size ? `, size ${h.size}` : ""}${h.maxPrice ? `, up to $${h.maxPrice}` : ""} (search: ${h.queries.join(" | ")})`).join("\n")
        : "- none";
      return text(`SCOUT (their taste)\n${renderBrief(taste)}\n${loc}\n\nScout searches: ${taste.queries.slice(0, 15).map((q) => q.q).join(" · ")}\n\nHUNTS (specific items they want)\n${huntLines}`);
    },
  );

  server.registerTool(
    "judge_listings",
    {
      title: "Judge listings against their taste",
      description:
        "Score 1-20 listings you found (Facebook Marketplace, Depop, Grailed, Poshmark, thrift shops). Without huntId they're judged as scout picks (0-10 taste score); with huntId, also as matches for that hunt (0-10 match score). Returns what each item really is and why. The best are pushed to their phone. Already-judged listings return their earlier verdict for free.",
      inputSchema: z.object({
        listings: z.array(listingInput).min(1).max(20),
        huntId: z.string().optional().describe("The hunt you were searching for, from get_taste_brief or hunts"),
      }),
    },
    async ({ listings, huntId }) => {
      try {
        const hunt = huntId ? await getHunt(huntId) : null;
        if (huntId && !hunt) return text(`No hunt with id ${huntId}.`);
        const run = await processListings(listings.map(toListing), "muse", hunt);
        const pushed = await notifyBest(run.candidates, 3, hunt ? [hunt] : []);
        if (hunt && run.candidates.length) await saveHunt({ ...hunt, matches: hunt.matches + run.candidates.length });
        return json({
          judged: run.judged,
          alreadySeen: run.alreadySeen,
          dropped: run.dropped,
          pushedToPhone: pushed,
          stoppedEarly: run.stoppedEarly,
          results: run.finds.map(brief),
        });
      } catch (err) {
        if (err instanceof NoTasteProfile) return text(err.message);
        throw err;
      }
    },
  );

  server.registerTool(
    "get_finds",
    {
      title: "Get recent finds",
      description: "The best recent finds, sorted by score. section \"scout\" = picks for their taste, \"hunt\" = matches for items they asked for. Use for \"anything good today?\"",
      inputSchema: z.object({
        section: z.enum(["all", "scout", "hunt"]).default("all"),
        huntId: z.string().optional(),
        minScore: z.number().min(0).max(10).default(7).describe("Taste for scout picks, match for hunt finds"),
        sinceHours: z.number().min(1).max(24 * 30).default(24),
        source: z.enum(SOURCES).optional(),
        includeRated: z.boolean().default(false).describe("Include finds they already rated"),
        limit: z.number().int().min(1).max(50).default(10),
      }),
    },
    async ({ section, huntId, minScore, sinceHours, source, includeRated, limit }) => {
      const finds = (await recentFinds(Date.now() - sinceHours * 3_600_000, 500))
        .filter(
          (f) =>
            score(f) >= minScore &&
            (section === "all" || f.mode === section) &&
            (!huntId || f.huntId === huntId) &&
            (!source || f.source === source) &&
            (includeRated || !f.rating),
        )
        .sort((a, b) => Number(b.mode === "hunt") - Number(a.mode === "hunt") || score(b) - score(a))
        .slice(0, limit);
      return json({ count: finds.length, finds: finds.map(brief) });
    },
  );

  server.registerTool(
    "rate_find",
    {
      title: "Rate a find",
      description: "Record their reaction to a find so future scoring learns from it. Use the id from get_finds or judge_listings.",
      inputSchema: z.object({
        id: z.string(),
        rating: z.enum(["like", "dislike", "bought"]),
        note: z.string().max(300).optional().describe("Their reason in their words, e.g. \"too cropped\" or \"want more like this in brown\""),
      }),
    },
    async ({ id, rating, note }) => {
      const find = await rateFind(id, rating, note ?? null);
      return text(find ? `Saved: ${rating} on "${find.verdict?.item ?? find.title}".` : `No find with id ${id}.`);
    },
  );

  server.registerTool(
    "price_check",
    {
      title: "Price check",
      description:
        "Is this a good price? Uses what similar items actually sold for on Grailed, plus live eBay asking prices (an upper bound) and fitscout's own estimate for a listing it has judged.",
      inputSchema: z.object({
        query: z.string().describe("Brand + item, e.g. \"carhartt detroit jacket blanket lined\""),
        findId: z.string().optional(),
        price: z.number().optional().describe("The listing's price, to compare against"),
      }),
    },
    async ({ query, findId, price }) => {
      const find = findId ? await getFind(findId) : null;
      const [sold, asking] = await Promise.all([
        grailedSoldComps(query).catch(() => null),
        ebayEnabled() ? ebayAskingComps(query).catch(() => null) : Promise.resolve(null),
      ]);
      const listed = price ?? find?.price ?? null;
      const value = sold?.median ?? find?.verdict?.estValueUsd ?? null;
      return json({
        query,
        listedPrice: listed,
        grailedSold: sold ?? "not enough recent sales",
        ebayAsking: asking ?? (ebayEnabled() ? "not enough listings" : "eBay not connected"),
        modelEstimateUsd: find?.verdict?.estValueUsd ?? null,
        verdict:
          listed != null && value != null
            ? listed <= value * 0.6
              ? `a steal: ${Math.round((1 - listed / value) * 100)}% under ${sold ? "what these sell for" : "estimated value"}`
              : listed <= value
                ? `fair: at or under ${sold ? "what these sell for" : "estimated value"}`
                : `pricey: above ${sold ? "what these sell for" : "estimated value"}`
            : "not enough data",
      });
    },
  );

  server.registerTool(
    "update_taste",
    {
      title: "Update sizes, budget, location, or notes",
      description: "Change their sizes, budget, pickup area, or add a free-text preference note (e.g. \"no more black jackets\", \"into suede this fall\").",
      inputSchema: z.object({
        sizes: z
          .object({
            tops: z.string().optional(),
            bottoms: z.string().optional(),
            shoes: z.string().optional(),
            notes: z.string().optional(),
            baggy: z.boolean().optional().describe("They wear bottoms baggy: up to 2 waist sizes over theirs still fits"),
          })
          .optional(),
        budget: z.object({ usualMax: z.number().positive().optional(), grailMax: z.number().positive().optional() }).optional(),
        location: z.object({ zip: z.string().optional(), radiusMi: z.number().positive().optional() }).optional(),
        note: z.string().max(300).optional(),
        avoid: z.string().max(120).optional().describe("A new red flag to avoid"),
        brands: z.array(z.string()).optional().describe("Replaces the list of brands they say they wear or like"),
      }),
    },
    async ({ sizes, budget, location, note, avoid, brands }) => {
      const taste = (await getTaste()) ?? emptyTaste();
      if (sizes) taste.sizes = { ...taste.sizes, ...sizes };
      if (budget) taste.budget = { ...taste.budget, ...budget };
      if (location) taste.location = { ...taste.location, ...location };
      if (note) taste.notes = [...taste.notes, note].slice(-30);
      if (avoid) taste.avoid = [...new Set([...taste.avoid, avoid])];
      if (brands) taste.myBrands = [...new Set(brands.map((b) => b.trim()).filter(Boolean))];
      taste.updatedAt = new Date().toISOString();
      await saveTaste(taste);
      return text(`Updated.\n\n${renderBrief(taste)}`);
    },
  );

  server.registerTool(
    "add_inspiration",
    {
      title: "Add inspiration images",
      description:
        "Teach it from new images of clothes they like (e.g. their saved Instagram posts). Detects each garment and folds it into the profile.",
      inputSchema: z.object({ imageUrls: z.array(z.string().url()).min(1).max(10), note: z.string().max(300).optional() }),
    },
    async ({ imageUrls, note }) => {
      const taste = (await getTaste()) ?? emptyTaste();
      const results = await Promise.allSettled(imageUrls.map((url) => detectGarments({ url })));
      const garments = results.flatMap((r) => (r.status === "fulfilled" ? r.value.garments : []));
      taste.exemplars = [...new Set([...garments.filter((g) => g.standout).map((g) => g.name), ...taste.exemplars])].slice(0, 80);
      taste.loves.brands = [...new Set([...taste.loves.brands, ...garments.map((g) => g.brand).filter((b): b is string => Boolean(b))])];
      const known = new Set(taste.queries.map((q) => q.q.toLowerCase()));
      for (const g of garments) for (const q of g.queries) if (!known.has(q.toLowerCase()) && taste.queries.length < 60) {
        taste.queries.push({ q, part: g.part, pillar: null });
        known.add(q.toLowerCase());
      }
      if (note) taste.notes = [...taste.notes, note].slice(-30);
      taste.photoCount += results.filter((r) => r.status === "fulfilled").length;
      taste.garmentCount += garments.length;
      taste.updatedAt = new Date().toISOString();
      await saveTaste(taste);
      const failed = results.filter((r) => r.status === "rejected").length;
      return json({ added: garments.map((g) => g.name), failedImages: failed });
    },
  );

  server.registerTool(
    "hunts",
    {
      title: "Manage hunts (specific items they want)",
      description:
        "List, add, pause, resume, or remove hunts: specific items they want found, e.g. \"brown Carhartt Detroit jacket, blanket lined\". fitscout searches eBay for every active hunt daily; you should also look for them on Marketplace. On add, search queries are generated if you don't pass any.",
      inputSchema: z.object({
        action: z.enum(["list", "add", "pause", "resume", "remove"]),
        want: z.string().max(300).optional().describe("For add: the item in their words, as specific as they were"),
        size: z.string().optional(),
        maxPrice: z.number().positive().optional(),
        notes: z.string().max(300).optional().describe("e.g. \"any colorway but black\", \"pre-2005 only\""),
        queries: z.array(z.string()).max(4).optional().describe("Optional search strings; generated if omitted"),
        id: z.string().optional().describe("For pause, resume, remove"),
      }),
    },
    async ({ action, want, size, maxPrice, notes, queries, id }) => {
      if (action === "add") {
        if (!want) return text("add needs want.");
        const hunt = await newHunt({ want, size, maxPrice, notes, queries });
        await saveHunt(hunt);
        return json({ added: hunt, note: "Searched on eBay in the next daily sweep." });
      }
      if (action === "list") {
        const hunts = await listHunts();
        return json({ count: hunts.length, hunts });
      }
      if (!id) return text(`${action} needs an id.`);
      if (action === "remove") return text((await removeHunt(id)) ? `Removed ${id}.` : `No hunt ${id}.`);
      const hunt: Hunt | null = await getHunt(id);
      if (!hunt) return text(`No hunt ${id}.`);
      await saveHunt({ ...hunt, active: action === "resume" });
      return text(`${action === "resume" ? "Resumed" : "Paused"}: ${hunt.want}`);
    },
  );

  server.registerTool(
    "draft_offer",
    {
      title: "Draft a message to a seller",
      description: "Drafts a short, friendly message or offer for a find. Returns text only. Show it to them; never send it without their explicit approval.",
      inputSchema: z.object({ id: z.string(), offer: z.number().positive().optional(), pickup: z.boolean().default(false) }),
    },
    async ({ id, offer, pickup }) => {
      const find = await getFind(id);
      if (!find) return text(`No find with id ${id}.`);
      const ask = offer ?? (find.price ? Math.round((find.price * 0.85) / 5) * 5 : null);
      const lines = [
        `Hi! Is this still available?`,
        find.size ? "" : "Could you share the measurements (pit to pit and length)?",
        ask && find.price && ask < find.price ? `Would you take $${ask}?` : "",
        pickup ? "I can pick up at a public spot that works for you." : "I can pay right away.",
      ].filter(Boolean);
      return json({ to: find.url, draft: lines.join(" "), note: "Draft only. Not sent." });
    },
  );

  server.registerTool(
    "tune_searches",
    {
      title: "Tune the searches",
      description:
        "Runs the tuning agent now: it reviews how each search has done and their recent ratings, test-runs candidate searches on Grailed, and rewrites the search list (at most 6 changes, each with a reason). Takes about 30 seconds.",
      inputSchema: z.object({}),
    },
    async () => {
      const result = await runTune();
      return json({ summary: result.summary, changes: result.changes, previews: result.previews });
    },
  );

  server.registerTool(
    "status",
    {
      title: "Status",
      description: "Health of fitscout: sources, last sweep, today's model spend, and whether the taste profile is loaded.",
      inputSchema: z.object({}),
    },
    async () => {
      const [taste, usage, hunts, sweep, ebay] = await Promise.all([getTaste(), usageToday(), listHunts(), getHealth("sweep"), getHealth("ebay")]);
      return json({
        scout: taste ? { photos: taste.photoCount, garments: taste.garmentCount, searches: taste.queries.length, updatedAt: taste.updatedAt } : null,
        hunts: { active: hunts.filter((h) => h.active).length, paused: hunts.filter((h) => !h.active).length },
        sources: { enabled: enabledSources(), ebay, marketplace: "via Muse" },
        lastSweep: sweep,
        schedule: "once daily",
        today: { ...usage, budgetUsd: config.dailyBudgetUsd, maxJudges: config.maxJudgesPerDay },
        pushConfigured: Boolean(config.ntfy.topic),
        store: usingMemoryStore() ? "memory (not persistent)" : "redis",
      });
    },
  );
}
