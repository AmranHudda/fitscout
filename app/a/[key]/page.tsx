import type { Metadata, Viewport } from "next";
import { rateUrl } from "@/lib/notify";
import { getHealth, listHunts, recentFinds, recentTuneLogs } from "@/lib/store";
import type { Find } from "@/lib/types";
import { uploadKeyOk } from "@/lib/uploads";
import { vapidPublicKey } from "@/lib/webpush";
import { FindsApp, type AgentLog, type FindCard, type TrackedItem } from "./finds";
import "./app.css";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ key: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { key } = await params;
  return {
    title: "fitscout",
    manifest: `/a/${key}/manifest`,
    appleWebApp: { capable: true, title: "fitscout", statusBarStyle: "default" },
    icons: { icon: "/icon-192.png", apple: "/apple-touch-icon.png" },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf9f7" },
    { media: "(prefers-color-scheme: dark)", color: "#151412" },
  ],
};

const DAY = 86_400_000;

function card(f: Find, hunts: Map<string, string>): FindCard {
  const v = f.verdict!;
  return {
    id: f.id,
    huntId: f.mode === "hunt" ? (f.huntId ?? null) : null,
    hunt: f.mode === "hunt" ? (hunts.get(f.huntId ?? "") ?? "a hunt") : null,
    score: (f.mode === "hunt" ? v.match : v.taste) ?? 0,
    item: v.item || f.title,
    title: f.title,
    price: f.price,
    source: f.source,
    size: f.size ?? null,
    url: f.url,
    image: f.images.find((u) => u.startsWith("https://")) ?? null,
    why: v.why,
    flags: v.flags,
    comps: f.comps ? { median: f.comps.median, n: f.comps.n } : null,
    underValuePct: f.dealRatio != null && f.dealRatio < 1 ? Math.round((1 - f.dealRatio) * 100) : null,
    rating: f.rating ?? null,
    firstSeen: f.firstSeen,
    like: rateUrl(f.id, "like"),
    dislike: rateUrl(f.id, "dislike"),
  };
}

// The home-screen app: finds picked for you (hunt matches first), with 👍/👎, plus notifications.
export default async function AppPage({ params }: Params) {
  const { key } = await params;
  if (!uploadKeyOk(key)) {
    return (
      <main className="app">
        <p className="eyebrow">fitscout</p>
        <h1>This link isn&apos;t valid.</h1>
      </main>
    );
  }
  const [finds, hunts, sweep, tunes] = await Promise.all([recentFinds(Date.now() - 30 * DAY, 150), listHunts(), getHealth("sweep"), recentTuneLogs(3)]);
  const huntNames = new Map(hunts.map((h) => [h.id, h.want]));
  const cards = finds.filter((f) => f.verdict).map((f) => card(f, huntNames));
  const agent: AgentLog = {
    tunes: tunes.map((t) => ({ at: t.at, summary: t.summary, changes: t.changes, previews: t.previews })),
    scan: sweep?.ok ? { at: sweep.at, judged: sweep.count } : null,
  };
  const tracked: TrackedItem[] = hunts.map((h) => ({
    id: h.id,
    want: h.want,
    size: h.size,
    maxPrice: h.maxPrice,
    photo: h.photo ?? null,
    active: h.active,
    lastRunAt: h.lastRunAt,
    queries: h.queries,
  }));
  return <FindsApp appKey={key} vapidKey={vapidPublicKey()} cards={cards} lastScan={sweep?.ok ? sweep.at : null} agent={agent} tracked={tracked} />;
}
