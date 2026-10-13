import { config } from "./config";
import { sign } from "./sign";
import type { Find, Hunt } from "./types";
import { appUrl } from "./uploads";
import { sendWebPush } from "./webpush";

export const rateUrl = (id: string, rating: "like" | "dislike") =>
  `${config.publicUrl}/api/rate?id=${encodeURIComponent(id)}&r=${rating}&s=${sign(`${id}:${rating}`)}`;

const money = (n: number | null) => (n == null ? "?" : `$${Math.round(n)}`);

export function pushMessage(find: Find, hunt: Hunt | null = null) {
  const v = find.verdict!;
  const isHunt = find.mode === "hunt";
  const deal = find.dealRatio != null && find.dealRatio <= config.notify.dealRatio ? ` · ~${Math.round((1 - find.dealRatio) * 100)}% under value` : "";
  return {
    topic: config.ntfy.topic,
    title: (isHunt ? `Hunt match ${v.match}/10 · ${money(find.price)} · ${v.item}` : `${v.taste}/10 · ${money(find.price)} · ${v.item}`).slice(0, 120),
    message: [
      isHunt && hunt ? `You asked for: ${hunt.want}` : "",
      v.why,
      `${find.source}${find.size ? ` · size ${find.size}` : ""}${deal}`,
      find.comps ? `Sold on Grailed: median ${money(find.comps.median)} (${find.comps.n} sales)` : "",
      v.flags.length ? `⚠ ${v.flags.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    tags: [isHunt ? "dart" : "sparkles", find.source, ...(deal ? ["moneybag"] : [])],
    priority: isHunt || v.taste >= 9 || deal ? 5 : 4,
    click: find.url,
    ...(find.images[0] ? { attach: find.images[0] } : {}),
    actions: [
      { action: "http", label: "👍 Mine", url: rateUrl(find.id, "like"), method: "POST", clear: true },
      { action: "http", label: "👎 Nah", url: rateUrl(find.id, "dislike"), method: "POST", clear: true },
      { action: "view", label: "Open", url: find.url },
    ],
  };
}

// The home-screen app's version: no action buttons on iPhone, so tapping opens the find in the
// app, where 👍/👎 live.
export function webPushMessage(find: Find, hunt: Hunt | null = null) {
  const { title, message } = pushMessage(find, hunt);
  return { title, body: message, url: `${appUrl()}#${encodeURIComponent(find.id)}`, tag: find.id };
}

async function ntfy(body: object) {
  if (!config.ntfy.topic) return false;
  const res = await fetch(config.ntfy.server, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.ok;
}

// Pushes to the home-screen app and to ntfy (if a topic is set). True if either got it.
export async function push(find: Find, hunt: Hunt | null = null) {
  const [web, viaNtfy] = await Promise.all([sendWebPush(webPushMessage(find, hunt)), ntfy(pushMessage(find, hunt))]);
  return web > 0 || viaNtfy;
}

export async function pushText(title: string, message: string) {
  const [web, viaNtfy] = await Promise.all([
    sendWebPush({ title, body: message, url: appUrl(), tag: title }),
    ntfy({ topic: config.ntfy.topic, title, message, tags: ["warning"] }),
  ]);
  return web > 0 || viaNtfy;
}
