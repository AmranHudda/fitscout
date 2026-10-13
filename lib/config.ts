const num = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return value && Number.isFinite(n) ? n : fallback;
};

const publicUrl = () => {
  if (process.env.FITSCOUT_PUBLIC_URL) return process.env.FITSCOUT_PUBLIC_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return "http://localhost:3000";
};

export const config = {
  // Shared secret for the MCP endpoint, the cron route, and signed ntfy buttons.
  token: process.env.FITSCOUT_TOKEN ?? "",
  publicUrl: publicUrl(),
  ntfy: {
    server: (process.env.NTFY_SERVER ?? "https://ntfy.sh").replace(/\/$/, ""),
    topic: process.env.NTFY_TOPIC ?? "",
  },
  models: {
    vision: process.env.OPENAI_VISION_MODEL ?? "gpt-5.4-mini",
    judge: process.env.OPENAI_JUDGE_MODEL ?? "gpt-5.4-mini",
    synth: process.env.OPENAI_SYNTH_MODEL ?? "gpt-5.6-sol",
  },
  // Hard stops on OpenAI spend. Costs are estimated from token usage and MODEL_PRICES.
  dailyBudgetUsd: num(process.env.FITSCOUT_DAILY_BUDGET_USD, 2),
  maxJudgesPerDay: num(process.env.FITSCOUT_MAX_JUDGES_PER_DAY, 400),
  notify: {
    minTaste: num(process.env.FITSCOUT_NOTIFY_MIN_TASTE, 8),
    // A 7 still pings when it is listed at or below this fraction of its estimated value.
    dealMinTaste: num(process.env.FITSCOUT_DEAL_MIN_TASTE, 7),
    dealRatio: num(process.env.FITSCOUT_DEAL_RATIO, 0.5),
    huntMinMatch: num(process.env.FITSCOUT_HUNT_MIN_MATCH, 8),
  },
  // Listings that score at least this on the cheap pass get a second, high-detail look.
  escalateAt: num(process.env.FITSCOUT_ESCALATE_AT, 7),
  // The sweep runs once a day: every active hunt, plus a rotating slice of scout searches.
  sweep: {
    scoutQueriesPerRun: num(process.env.FITSCOUT_SCOUT_QUERIES_PER_RUN, 12),
    perQuery: num(process.env.FITSCOUT_RESULTS_PER_QUERY, 20), // 12 searches x 20 keeps a scan well inside the 5-minute limit
    maxPushes: num(process.env.FITSCOUT_MAX_PUSHES_PER_RUN, 6),
  },
  ebay: {
    clientId: process.env.EBAY_CLIENT_ID ?? "",
    clientSecret: process.env.EBAY_CLIENT_SECRET ?? "",
    marketplace: process.env.EBAY_MARKETPLACE ?? "EBAY_US",
  },
};

// USD per 1M tokens [input, output]. Unknown models fall back to a deliberately high price
// so the daily cap errs on the safe side. Override with OPENAI_PRICE_<MODEL>="in,out".
const DEFAULT_PRICES: Record<string, [number, number]> = {
  "gpt-5.4-mini": [1, 6],
  "gpt-5.4-nano": [0.25, 2],
  "gpt-5.6-sol": [10, 40],
};

export function modelPrice(model: string): [number, number] {
  const override = process.env[`OPENAI_PRICE_${model.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`];
  if (override) {
    const [i, o] = override.split(",").map(Number);
    if (Number.isFinite(i) && Number.isFinite(o)) return [i, o];
  }
  return DEFAULT_PRICES[model] ?? [10, 40];
}
