import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Redis } from "@upstash/redis";
import type { Feedback, Find, Garment, Hunt, Outfit, Rating, Source, TasteProfile } from "./types";

// The subset of Upstash Redis that fitscout uses, so tests and local dev can run in memory.
interface Kv {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { nx?: boolean; ex?: number }): Promise<"OK" | null>;
  del(key: string): Promise<number>;
  zadd(key: string, entry: { score: number; member: string }): Promise<number | null>;
  zrange<T>(key: string, min: number, max: number, opts: { byScore: true; rev: true; offset: number; count: number }): Promise<T>;
  lpush(key: string, value: string): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<string>;
  lrange<T>(key: string, start: number, stop: number): Promise<T[]>;
  hset(key: string, values: Record<string, unknown>): Promise<number>;
  hgetall<T extends Record<string, unknown>>(key: string): Promise<T | null>;
  hdel(key: string, field: string): Promise<number>;
  incrbyfloat(key: string, by: number): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

class MemoryKv implements Kv {
  private data = new Map<string, unknown>();
  constructor() {
    // Local dev only: start with a taste profile so the MCP tools can be tried without Redis.
    const seed = process.env.FITSCOUT_DEV_TASTE;
    if (seed) this.data.set("taste", JSON.parse(readFileSync(seed, "utf8")));
  }
  async get<T>(key: string) {
    return (this.data.get(key) as T) ?? null;
  }
  async set(key: string, value: unknown, opts?: { nx?: boolean }) {
    if (opts?.nx && this.data.has(key)) return null;
    this.data.set(key, structuredClone(value));
    return "OK" as const;
  }
  async del(key: string) {
    return this.data.delete(key) ? 1 : 0;
  }
  async zadd(key: string, { score, member }: { score: number; member: string }) {
    const z = (this.data.get(key) as Map<string, number>) ?? new Map<string, number>();
    z.set(member, score);
    this.data.set(key, z);
    return 1;
  }
  async zrange<T>(key: string, min: number, max: number, opts: { offset: number; count: number }) {
    const z = (this.data.get(key) as Map<string, number>) ?? new Map<string, number>();
    // Called with rev + byScore, so `min` is the high bound.
    const members = [...z.entries()].filter(([, s]) => s <= min && s >= max).sort((a, b) => b[1] - a[1]).map(([m]) => m);
    return members.slice(opts.offset, opts.offset + opts.count) as T;
  }
  async lpush(key: string, value: string) {
    const list = (this.data.get(key) as string[]) ?? [];
    list.unshift(value);
    this.data.set(key, list);
    return list.length;
  }
  async ltrim(key: string, start: number, stop: number) {
    const list = (this.data.get(key) as string[]) ?? [];
    this.data.set(key, list.slice(start, stop + 1));
    return "OK";
  }
  async lrange<T>(key: string, start: number, stop: number) {
    const list = (this.data.get(key) as string[]) ?? [];
    return list.slice(start, stop === -1 ? undefined : stop + 1).map((v) => JSON.parse(v)) as T[];
  }
  async hset(key: string, values: Record<string, unknown>) {
    const h = (this.data.get(key) as Record<string, unknown>) ?? {};
    Object.assign(h, values);
    this.data.set(key, h);
    return Object.keys(values).length;
  }
  async hgetall<T extends Record<string, unknown>>(key: string): Promise<T | null> {
    return (this.data.get(key) as T | undefined) ?? null;
  }
  async hdel(key: string, field: string) {
    const h = (this.data.get(key) as Record<string, unknown>) ?? {};
    const had = field in h;
    delete h[field];
    return had ? 1 : 0;
  }
  async incrbyfloat(key: string, by: number) {
    const v = Number(this.data.get(key) ?? 0) + by;
    this.data.set(key, v);
    return v;
  }
  async incr(key: string) {
    return this.incrbyfloat(key, 1);
  }
  async expire() {
    return 1;
  }
}

// Every Kv method takes the key first; this namespaces all of fitscout's keys.
function prefixed(inner: Kv, prefix: string): Kv {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (key: string, ...rest: unknown[]) => value.call(target, `${prefix}${key}`, ...rest);
    },
  });
}

// Upstash Redis (reads KV_REST_API_URL / KV_REST_API_TOKEN). The database is shared with
// thumbs-bot, so every fitscout key lives under "fitscout:".
let client: Kv | undefined;
export const kv = (): Kv =>
  (client ??= process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL ? prefixed(Redis.fromEnv() as unknown as Kv, "fitscout:") : new MemoryKv());
export const usingMemoryStore = () => !(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL);

const DAY = 86_400;
const today = () => new Date().toISOString().slice(0, 10);

// --- taste ---
export const getTaste = () => kv().get<TasteProfile>("taste");
export const saveTaste = (taste: TasteProfile) => kv().set("taste", taste);

// --- garments from uploaded photos ---
export interface GarmentRow {
  photo: string; // blob pathname
  original: string; // filename on the phone
  garments: Garment[]; // the chosen person's; what the profile is built from
  outfits?: Outfit[]; // everyone detected in the photo
  chosen?: number; // index into outfits, or -1 for "none of these"
  found?: boolean; // chosen by matching the user's face on their phone
  at: string;
}
export const addGarmentRow = (row: GarmentRow) => kv().lpush("garments", JSON.stringify(row));
// Which person in a photo is you. Kept beside the list so a choice never rewrites a row.
export const chooseOutfit = (photo: string, index: number) => kv().hset("outfit-choice", { [photo]: index });
export async function garmentRows() {
  const [rows, choices] = await Promise.all([kv().lrange<GarmentRow>("garments", 0, -1), kv().hgetall<Record<string, number>>("outfit-choice")]);
  return rows.map((row) => {
    const choice = choices?.[row.photo];
    if (choice == null || !row.outfits) return row;
    const chosen = Number(choice);
    return { ...row, chosen, garments: row.outfits[chosen]?.garments ?? [] };
  });
}

// --- finds ---
// Returns true the first time a listing is seen in the last 30 days, per scope ("scout" or a hunt id),
// so a listing skipped as a scout pick can still be judged as a hunt match.
export async function markSeen(id: string, scope = "scout") {
  return (await kv().set(`seen:${scope}:${id}`, 1, { nx: true, ex: 30 * DAY })) === "OK";
}
// Lets a listing be judged again on a later run (after a budget stop or a failed call).
export const unmarkSeen = (id: string, scope = "scout") => kv().del(`seen:${scope}:${id}`);

export async function saveFind(find: Find) {
  // A hunt match outranks a scout pick for the same listing; never overwrite one with the other.
  const existing = find.mode === "scout" ? await getFind(find.id) : null;
  if (existing?.mode === "hunt") return;
  await kv().set(`find:${find.id}`, find, { ex: 60 * DAY });
  await kv().zadd("feed", { score: Date.parse(find.firstSeen), member: find.id });
}

export const getFind = (id: string) => kv().get<Find>(`find:${id}`);

export async function recentFinds(sinceMs: number, limit = 200): Promise<Find[]> {
  const ids = await kv().zrange<string[]>("feed", Date.now(), sinceMs, { byScore: true, rev: true, offset: 0, count: limit });
  const finds = await Promise.all(ids.map((id) => getFind(id)));
  return finds.filter((f): f is Find => f !== null);
}

// --- feedback ---
const FEEDBACK_LENGTH = 200;

export async function rateFind(id: string, rating: Rating, note: string | null = null) {
  const find = await getFind(id);
  if (!find) return null;
  find.rating = rating;
  await kv().set(`find:${id}`, find, { ex: 60 * DAY });
  const entry: Feedback = {
    id,
    rating,
    title: find.title,
    item: find.verdict?.item ?? null,
    why: find.verdict?.why ?? null,
    price: find.price,
    note,
    at: new Date().toISOString(),
  };
  await kv().lpush("feedback", JSON.stringify(entry));
  await kv().ltrim("feedback", 0, FEEDBACK_LENGTH - 1);
  return find;
}

export const recentFeedback = (n = 40) => kv().lrange<Feedback>("feedback", 0, n - 1);

// --- hunts ---
export async function listHunts(): Promise<Hunt[]> {
  const all = (await kv().hgetall<Record<string, Hunt | string>>("hunts")) ?? {};
  return Object.values(all)
    .map((h) => (typeof h === "string" ? (JSON.parse(h) as Hunt) : h))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export async function getHunt(id: string) {
  return (await listHunts()).find((h) => h.id === id) ?? null;
}
export const saveHunt = (hunt: Hunt) => kv().hset("hunts", { [hunt.id]: hunt });
export const removeHunt = (id: string) => kv().hdel("hunts", id);

// Scout searches come straight from the taste profile, handed out round-robin so each
// daily sweep covers a different slice.
export async function nextScoutQueries(queries: string[], n: number): Promise<string[]> {
  if (queries.length <= n) return queries;
  const start = ((await kv().incr("scout-cursor")) - 1) * n;
  return Array.from({ length: n }, (_, i) => queries[(start + i) % queries.length]);
}

// --- spend and health ---
export async function addSpend(usd: number) {
  const key = `spend:${today()}`;
  const total = await kv().incrbyfloat(key, usd);
  await kv().expire(key, 7 * DAY);
  return total;
}
export async function countJudge() {
  const key = `judges:${today()}`;
  const n = await kv().incr(key);
  await kv().expire(key, 7 * DAY);
  return n;
}
// True only for the first call per key per day (used to send one budget alert, not hundreds).
// --- how each scout search has done, and what the tuning agent changed ---
export interface QueryStats {
  runs: number;
  found: number; // listings returned, all runs
  judged: number;
  picks: number; // judged 7+
  best: number; // best score ever
  lastRun: string;
  lastTop: string[]; // a few recent top-scoring items, for the tuning agent
}
export const getQueryStats = async () => (await kv().hgetall<Record<string, QueryStats>>("query-stats")) ?? {};
export const saveQueryStats = (stats: Record<string, QueryStats>) => (Object.keys(stats).length ? kv().hset("query-stats", stats) : Promise.resolve(0));

export interface TuneChange {
  action: "add" | "replace" | "remove" | "avoid";
  query: string; // the search added/removed, or the avoid rule
  replaced?: string;
  reason: string;
}
export interface TuneLog {
  at: string;
  summary: string;
  changes: TuneChange[];
  previews: number; // searches it test-ran on Grailed
  costUsd: number;
}
export async function addTuneLog(entry: TuneLog) {
  await kv().lpush("tune-log", JSON.stringify(entry));
  await kv().ltrim("tune-log", 0, 29);
}
export const recentTuneLogs = (n = 5) => kv().lrange<TuneLog>("tune-log", 0, n - 1);

// --- web push subscriptions (one per installed home-screen app) ---
export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
const subKey = (endpoint: string) => createHash("sha256").update(endpoint).digest("hex").slice(0, 24);
export const savePushSub = (sub: PushSub) => kv().hset("push-subs", { [subKey(sub.endpoint)]: sub });
export const removePushSub = (endpoint: string) => kv().hdel("push-subs", subKey(endpoint));
export const listPushSubs = async () => Object.values((await kv().hgetall<Record<string, PushSub>>("push-subs")) ?? {});

// True at most once per `seconds` for a key, e.g. to rate-limit "Scan now".
export async function oncePer(key: string, seconds: number) {
  return (await kv().set(`once:${key}`, 1, { nx: true, ex: seconds })) === "OK";
}

export async function onceToday(key: string) {
  return (await kv().set(`once:${key}:${today()}`, 1, { nx: true, ex: 2 * DAY })) === "OK";
}
export async function usageToday() {
  const [spend, judges] = await Promise.all([kv().get<number>(`spend:${today()}`), kv().get<number>(`judges:${today()}`)]);
  return { spendUsd: Number(spend ?? 0), judges: Number(judges ?? 0) };
}

export interface SourceHealth {
  ok: boolean;
  at: string;
  count: number;
  error: string | null;
}
export const setHealth = (source: Source | "sweep", health: SourceHealth) => kv().set(`health:${source}`, health);
export const getHealth = (source: Source | "sweep") => kv().get<SourceHealth>(`health:${source}`);
