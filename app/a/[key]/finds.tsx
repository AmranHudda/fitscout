"use client";

import { useEffect, useState } from "react";

export interface FindCard {
  id: string;
  huntId: string | null;
  hunt: string | null; // what they asked for, when this matched a hunt
  score: number;
  item: string;
  title: string;
  price: number | null;
  source: string;
  size: string | null;
  url: string;
  image: string | null;
  why: string;
  flags: string[];
  comps: { median: number; n: number } | null;
  underValuePct: number | null;
  rating: "like" | "dislike" | "bought" | null;
  firstSeen: string;
  like: string; // signed rate links
  dislike: string;
}

export interface TrackedItem {
  id: string;
  want: string;
  size: string | null;
  maxPrice: number | null;
  photo: string | null;
  active: boolean;
  lastRunAt: string | null;
  queries: string[];
}

export interface AgentLog {
  tunes: { at: string; summary: string; changes: { action: string; query: string; replaced?: string; reason: string }[]; previews: number }[];
  scan: { at: string; judged: number } | null;
}

type Notif = "checking" | "unsupported" | "install" | "off" | "on" | "blocked" | "working";

const PICK = 7; // scores at or above this are "picks"; the rest are things it looked at

const money = (n: number | null) => (n == null ? "?" : `$${Math.round(n)}`);

function keyBytes(base64url: string) {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// A small square JPEG for the tracker: enough for the model to recognize the item.
async function thumbnail(file: File): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const url = canvas.toDataURL("image/jpeg", 0.8);
    canvas.width = canvas.height = 0;
    return url;
  } catch {
    return null;
  }
}

function ago(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

export function FindsApp({
  appKey,
  vapidKey,
  cards: initial,
  lastScan,
  agent,
  tracked: initialTracked,
}: {
  appKey: string;
  vapidKey: string;
  cards: FindCard[];
  lastScan: string | null;
  agent: AgentLog;
  tracked: TrackedItem[];
}) {
  const [tracked, setTracked] = useState(initialTracked);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ want: "", size: "", maxPrice: "", photo: null as string | null });
  const [trackNote, setTrackNote] = useState("");
  const k = encodeURIComponent(appKey);
  const [cards, setCards] = useState(initial);
  const [notif, setNotif] = useState<Notif>("checking");
  const [note, setNote] = useState("");
  const [scan, setScan] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [focus, setFocus] = useState("");

  const save = (sub: PushSubscription) =>
    fetch(`/api/push/subscribe?k=${k}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub.toJSON()) });

  useEffect(() => {
    const target = decodeURIComponent(location.hash.slice(1));
    if (target) {
      setFocus(target);
      setShowAll(true);
      setTimeout(() => document.getElementById(target)?.scrollIntoView({ block: "center" }), 50);
    }
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        // On iPhone, push only exists once the page is opened from the Home Screen.
        const iphone = /iPhone|iPad|iPod/.test(navigator.userAgent);
        return setNotif(iphone ? "install" : "unsupported");
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      if (Notification.permission === "denied") return setNotif("blocked");
      const sub = await reg.pushManager.getSubscription();
      if (sub && Notification.permission === "granted") {
        await save(sub); // re-register in case the server dropped it
        return setNotif("on");
      }
      setNotif("off");
    })().catch(() => setNotif("unsupported"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function enable() {
    setNotif("working");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return setNotif(permission === "denied" ? "blocked" : "off");
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidKey) }));
      const res = await save(sub);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNotif("on");
      setNote("");
    } catch (err) {
      setNotif("off");
      setNote(`Couldn't turn on notifications (${(err as Error).message}).`);
    }
  }

  async function test() {
    setNote("Sending…");
    const res = await fetch(`/api/push/test?k=${k}`, { method: "POST" }).catch(() => null);
    const json = res?.ok ? await res.json() : null;
    setNote(json?.sent ? "Sent. It should show up in a few seconds." : "Couldn't send. Try turning notifications off and on.");
  }

  async function runScan() {
    setScan("Starting…");
    const res = await fetch(`/api/app/scan?k=${k}`, { method: "POST" }).catch(() => null);
    const json = res ? await res.json().catch(() => ({})) : {};
    setScan(res?.status === 202 ? "Scanning now. Good finds arrive as notifications in a few minutes; pull down or reopen to refresh." : (json.error ?? "Couldn't start a scan."));
  }

  async function track(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.want.trim() && !draft.photo) return setTrackNote("Add a photo or describe the item.");
    setTrackNote(draft.photo ? "Reading your photo…" : "Setting it up…");
    const res = await fetch(`/api/app/hunts?k=${k}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ want: draft.want, size: draft.size || null, maxPrice: draft.maxPrice ? Number(draft.maxPrice) : null, photo: draft.photo }),
    }).catch(() => null);
    const json = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok) return setTrackNote(json.error ?? "Couldn't add it. Try again.");
    setTracked((all) => [...all, { ...json.hunt, photo: draft.photo, active: true, lastRunAt: null }]);
    setDraft({ want: "", size: "", maxPrice: "", photo: null });
    setAdding(false);
    setTrackNote(`Tracking "${json.hunt.want}". Searching now; matches arrive as notifications and show up here.`);
  }

  async function changeTracked(item: TrackedItem, action: "pause" | "resume" | "remove") {
    const res = await fetch(`/api/app/hunts?k=${k}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: item.id, action }),
    }).catch(() => null);
    if (!res?.ok) return setTrackNote("Couldn't change that. Try again.");
    setTracked((all) => (action === "remove" ? all.filter((t) => t.id !== item.id) : all.map((t) => (t.id === item.id ? { ...t, active: action === "resume" } : t))));
  }

  async function rate(card: FindCard, rating: "like" | "dislike") {
    setCards((all) => all.map((c) => (c.id === card.id ? { ...c, rating } : c)));
    const res = await fetch(rating === "like" ? card.like : card.dislike, { method: "POST" }).catch(() => null);
    if (!res?.ok) setCards((all) => all.map((c) => (c.id === card.id ? { ...c, rating: card.rating } : c)));
  }

  const matchesFor = (id: string) => cards.filter((c) => c.huntId === id && c.score >= 6).sort((a, b) => b.score - a.score);
  // Best first; among equal scores, newest first.
  const picks = cards.filter((c) => !c.hunt && c.score >= PICK).sort((a, b) => b.score - a.score || b.firstSeen.localeCompare(a.firstSeen));
  const rest = cards.filter((c) => c.score < PICK).sort((a, b) => b.score - a.score);

  const item = (c: FindCard) => (
    <li key={c.id} id={c.id} className={`find${c.id === focus ? " focus" : ""}${c.rating ? ` rated-${c.rating}` : ""}`}>
      <a href={c.url} target="_blank" rel="noreferrer" className="thumb">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {c.image ? <img src={c.image} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="noimg">no photo</span>}
      </a>
      <div className="body">
        <p className="meta">
          <strong className="score">{c.score}/10</strong> · {money(c.price)} · {c.source}
          {c.size ? ` · ${c.size}` : ""}
          {c.underValuePct != null && c.underValuePct >= 30 ? <span className="deal"> {c.underValuePct}% under</span> : null}
        </p>
        <p className="item">{c.item}</p>
        {c.hunt && <p className="hunt">For: {c.hunt}</p>}
        <p className="why">{c.why}</p>
        {c.comps && <p className="small">Sold on Grailed: ~{money(c.comps.median)} ({c.comps.n} sales)</p>}
        {c.flags.length > 0 && <p className="small flags">⚠ {c.flags.join(", ")}</p>}
        <div className="actions">
          <button type="button" className={c.rating === "like" ? "on" : ""} onClick={() => rate(c, "like")}>
            👍 Mine
          </button>
          <button type="button" className={c.rating === "dislike" ? "on" : ""} onClick={() => rate(c, "dislike")}>
            👎 Nah
          </button>
          <a href={c.url} target="_blank" rel="noreferrer">
            Open ↗
          </a>
        </div>
      </div>
    </li>
  );

  return (
    <main className="app">
      <header>
        <p className="eyebrow">fitscout</p>
        <h1>Your finds</h1>
        <p className="small">{lastScan ? `Last scan ${ago(lastScan)}. ` : ""}Scans every morning.</p>
        <div className="bar">
          <button type="button" className="primary" onClick={runScan} disabled={scan === "Starting…"}>
            Scan now
          </button>
          <a className="secondary" href={`/u/${k}`}>
            Add photos
          </a>
        </div>
        {scan && <p className="small">{scan}</p>}
      </header>

      <section className={`notif ${notif}`}>
        {notif === "install" && (
          <p>
            <strong>Get notified about finds:</strong> tap Share <span aria-hidden>⎙</span>, then <em>Add to Home Screen</em>. Open fitscout from your Home Screen and
            turn on notifications there.
          </p>
        )}
        {notif === "off" && (
          <>
            <p>
              <strong>Turn on notifications</strong> to hear about good finds the moment a scan picks them.
            </p>
            <button type="button" className="primary" onClick={enable}>
              Turn on notifications
            </button>
          </>
        )}
        {notif === "working" && <p>Turning on…</p>}
        {notif === "on" && (
          <p>
            Notifications are on.{" "}
            <button type="button" className="link" onClick={test}>
              Send a test
            </button>
          </p>
        )}
        {notif === "blocked" && <p>Notifications are blocked. Turn them on in Settings › Notifications › fitscout.</p>}
        {notif === "unsupported" && <p>This browser can&apos;t get notifications. On iPhone, add fitscout to your Home Screen from Safari.</p>}
        {note && <p className="small">{note}</p>}
      </section>

      <section className="tracker">
        <h2>Tracker</h2>
        {tracked.map((t) => {
          const matches = matchesFor(t.id);
          return (
            <div key={t.id} className={`tracked${t.active ? "" : " paused"}`}>
              <div className="head">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {t.photo ? <img src={t.photo} alt="" /> : <span className="noimg">no photo</span>}
                <div>
                  <p className="item">{t.want}</p>
                  <p className="small">
                    {[t.size && `size ${t.size}`, t.maxPrice && `under $${t.maxPrice}`].filter(Boolean).join(" · ")}
                    {t.size || t.maxPrice ? " · " : ""}
                    {!t.active ? "paused" : t.lastRunAt ? `checked ${ago(t.lastRunAt)} · ${matches.length} match${matches.length === 1 ? "" : "es"}` : "searching now…"}
                  </p>
                  <p className="small">
                    <button type="button" className="link" onClick={() => changeTracked(t, t.active ? "pause" : "resume")}>
                      {t.active ? "Pause" : "Resume"}
                    </button>
                    {" · "}
                    <button type="button" className="link" onClick={() => changeTracked(t, "remove")}>
                      Remove
                    </button>
                  </p>
                </div>
              </div>
              {matches.length > 0 && <ul className="finds">{matches.slice(0, 5).map(item)}</ul>}
            </div>
          );
        })}
        {adding ? (
          <form className="add" onSubmit={track}>
            <label className="photo">
              <input
                type="file"
                accept="image/*"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const photo = await thumbnail(file);
                  setDraft((d) => ({ ...d, photo }));
                }}
              />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {draft.photo ? <img src={draft.photo} alt="" /> : <span>+ Photo</span>}
            </label>
            <div className="fields">
              <input type="text" placeholder="What is it? e.g. cream cable-knit Ralph Lauren quarter-zip" value={draft.want} onChange={(e) => setDraft((d) => ({ ...d, want: e.target.value }))} />
              <div className="row">
                <input type="text" placeholder="Size" value={draft.size} onChange={(e) => setDraft((d) => ({ ...d, size: e.target.value }))} />
                <input type="number" inputMode="numeric" placeholder="Max $" value={draft.maxPrice} onChange={(e) => setDraft((d) => ({ ...d, maxPrice: e.target.value }))} />
              </div>
              <div className="row">
                <button type="submit" className="primary">
                  Track it
                </button>
                <button type="button" className="secondary" onClick={() => setAdding(false)}>
                  Cancel
                </button>
              </div>
            </div>
          </form>
        ) : (
          <button type="button" className="secondary wide" onClick={() => setAdding(true)}>
            + Track an item
          </button>
        )}
        {trackNote && <p className="small">{trackNote}</p>}
      </section>
      <section>
        <h2>Picks for you</h2>
        {picks.length ? <ul className="finds">{picks.map(item)}</ul> : <p className="small empty">No picks yet. Tap Scan now, or check back after the morning scan.</p>}
      </section>
      {(agent.tunes.length > 0 || agent.scan) && (
        <section className="agents">
          <h2>What the agents did</h2>
          <ul>
            {agent.tunes.slice(0, 2).map((t) => (
              <li key={t.at}>
                <p>
                  <strong>Tuning agent</strong> · {ago(t.at)} · test-ran {t.previews} searches
                </p>
                <p>{t.summary}</p>
                {t.changes.length > 0 && (
                  <ul className="changes">
                    {t.changes.map((c, i) => (
                      <li key={i}>
                        {c.action === "replace" ? (
                          <>
                            <s>{c.replaced}</s> → <b>{c.query}</b>
                          </>
                        ) : c.action === "remove" ? (
                          <s>{c.query}</s>
                        ) : c.action === "avoid" ? (
                          <>
                            avoid: <b>{c.query}</b>
                          </>
                        ) : (
                          <>
                            + <b>{c.query}</b>
                          </>
                        )}
                        <span className="small"> — {c.reason}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
            {agent.scan && (
              <li>
                <p>
                  <strong>Scout + judge</strong> · {ago(agent.scan.at)} · judged {agent.scan.judged} listings against your profile
                </p>
              </li>
            )}
          </ul>
        </section>
      )}

      {rest.length > 0 && (
        <section>
          {showAll ? (
            <>
              <h2>Everything else it looked at</h2>
              <ul className="finds">{rest.map(item)}</ul>
            </>
          ) : (
            <button type="button" className="secondary wide" onClick={() => setShowAll(true)}>
              Show {rest.length} more it looked at
            </button>
          )}
        </section>
      )}
    </main>
  );
}
