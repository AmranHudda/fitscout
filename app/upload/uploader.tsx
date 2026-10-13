"use client";

import { useEffect, useRef, useState } from "react";
import { findMe, loadMe, markFace, referenceFace, release, saveMe } from "./face";

interface OutfitChoice {
  position: string;
  outfit: string;
  garments: string[];
}

interface PhotoSummary {
  photo: string;
  garments: string[];
  outfits: OutfitChoice[];
  chosen: number;
  found: boolean; // picked by matching your face
}

interface Initial {
  photos: number;
  garments: number;
  builtFrom: number;
  brief: string;
  pillars: { name: string; description: string }[];
  sizes: { tops: string; bottoms: string; shoes: string; baggy: boolean };
  budget: { usualMax: number; grailMax: number };
  location: { zip: string; radiusMi: number };
  groups: PhotoSummary[]; // earlier photos with more than one person in them
  brands: string[];
}

interface Item {
  id: number;
  name: string;
  preview: string;
  state: "waiting" | "uploading" | "done" | "error";
  garments: string[];
  error?: string;
  photo?: string;
  outfits?: OutfitChoice[];
  chosen?: number;
  found?: boolean;
}

const STALE = "This page's link is out of date. Reopen your newest upload link.";

const MAX_EDGE = 1600;
const MAX_BYTES = 4_000_000; // the server's limit; Vercel rejects bigger requests before they arrive
const PARALLEL = 2;
const FACE_BUDGET_MS = 12_000; // past this, the photo uploads without looking for you

function draw(source: CanvasImageSource, width: number, height: number) {
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// Draws the photo at most ~1600px on a side, so uploads are fast and fit the request limit.
// Null if the browser can't decode or draw it here.
async function toCanvas(file: File): Promise<HTMLCanvasElement | null> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    try {
      return draw(bitmap, bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  } catch {
    // Some formats only decode through an <img>.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return draw(img, img.naturalWidth, img.naturalHeight);
    } catch {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
const toJpeg = (canvas: HTMLCanvasElement) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));

export function Uploader({ uploadKey, initial }: { uploadKey: string; initial: Initial }) {
  const k = encodeURIComponent(uploadKey);
  const [items, setItems] = useState<Item[]>(() =>
    initial.groups.map((g, i) => ({ id: -1 - i, name: "", preview: `/api/upload/photo?k=${k}&p=${encodeURIComponent(g.photo)}`, state: "done", ...g })),
  );
  const [counts, setCounts] = useState({ photos: initial.photos, garments: initial.garments });
  const [profile, setProfile] = useState({ brief: initial.brief, pillars: initial.pillars, searches: [] as string[], builtFrom: initial.builtFrom });
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState("");
  const [details, setDetails] = useState({ ...initial.sizes, ...initial.budget, ...initial.location, brands: initial.brands.join(", ") });
  const [savedDetails, setSavedDetails] = useState("");
  const [me, setMe] = useState<number[][]>([]);
  const [meNote, setMeNote] = useState("");
  const [refs, setRefs] = useState<{ preview: string; problem: string | null }[]>([]);
  const nextId = useRef(0);
  const files = useRef(new Map<number, File>()); // kept so failed photos can be retried without re-picking
  const faceStalled = useRef(false); // once face matching hangs, upload the rest without it
  useEffect(() => setMe(loadMe()), []);

  // Tells the server why a photo failed here, since phone-side failures never reach its logs otherwise.
  const report = (stage: string, message: string, file: File) =>
    fetch(`/api/upload/log?k=${k}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage, message, name: file.name, type: file.type, size: file.size }),
      keepalive: true,
    }).catch(() => undefined);

  const update = (id: number, patch: Partial<Item>) => setItems((all) => all.map((it) => (it.id === id ? { ...it, ...patch } : it)));

  async function uploadOne(item: Item, file: File) {
    update(item.id, { state: "uploading", error: undefined });
    let canvas: HTMLCanvasElement | null = null;
    let stage = "shrink";
    try {
      canvas = await toCanvas(file);
      const photo = canvas && (await toJpeg(canvas));
      if (!photo && file.size > MAX_BYTES) throw new Error("Couldn't shrink this photo on your phone. Tap Retry.");
      const form = new FormData();
      form.append("photo", photo || file);
      // Your face is found here on the phone; the server only gets a copy with it boxed in green.
      if (canvas && me.length && !faceStalled.current) {
        stage = "face";
        // A hard cap too: on a phone low on memory, the face matcher can stop responding entirely.
        const timeout = new Promise<"stalled">((resolve) => setTimeout(() => resolve("stalled"), FACE_BUDGET_MS + 8_000));
        const result = await Promise.race([findMe(canvas, me, Date.now() + FACE_BUDGET_MS).catch(() => null), timeout]);
        if (result === "stalled") {
          faceStalled.current = true;
          setMeNote("Face matching stopped responding, so the rest upload without it. Tap yourself on group photos, or reopen the link to turn it back on.");
          report("face", "face matching stalled; continuing without it", file);
        }
        const box = result === "stalled" ? null : result;
        if (box) {
          const copy = markFace(canvas, box);
          const marked = await toJpeg(copy);
          release(copy);
          if (marked) form.append("marked", marked);
        }
      }
      if (canvas) release(canvas);
      canvas = null;
      stage = "upload";
      const res = await fetch(`/api/upload?k=${k}&name=${encodeURIComponent(file.name)}`, { method: "POST", body: form });
      if (res.status === 403) throw new Error(STALE);
      const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const summary = json as PhotoSummary;
      files.current.delete(item.id);
      update(item.id, { state: "done", ...summary });
      setCounts((c) => ({ photos: c.photos + 1, garments: c.garments + summary.garments.length }));
    } catch (err) {
      const message = (err as Error).message || "Upload failed";
      update(item.id, { state: "error", error: message });
      report(stage, message, file);
    } finally {
      if (canvas) release(canvas);
    }
  }

  // Uploads a few at a time; more at once runs a phone out of memory.
  async function run(batch: { item: Item; file: File }[]) {
    let next = 0;
    await Promise.all(
      Array.from({ length: PARALLEL }, async () => {
        while (next < batch.length) {
          const p = batch[next++];
          await uploadOne(p.item, p.file);
        }
      }),
    );
  }

  function retryFailed() {
    const batch = items.filter((it) => it.state === "error" && files.current.has(it.id)).map((item) => ({ item, file: files.current.get(item.id)! }));
    batch.forEach((p) => update(p.item.id, { state: "waiting", error: undefined }));
    run(batch);
  }

  // Reference photos of you: kept as face signatures in this browser, never uploaded.
  async function addMe(files: FileList | null) {
    if (!files?.length) return;
    setMeNote("Loading the face matcher (about 12 MB, once)…");
    const found: number[][] = [];
    const checked: typeof refs = [];
    setRefs([]);
    try {
      for (const file of Array.from(files)) {
        const canvas = await toCanvas(file);
        const face = canvas && (await referenceFace(canvas));
        if (face) found.push(face);
        checked.push({ preview: URL.createObjectURL(file), problem: !canvas ? "couldn't open" : face ? null : "no face found" });
        setRefs([...checked]);
        setMeNote(`Reading your photos… ${found.length} faces found`);
      }
    } catch {
      return setMeNote("Couldn't load the face matcher. Check your connection and try again.");
    }
    const next = [...me, ...found].slice(-12);
    setMe(next);
    saveMe(next);
    const tip = "Clear, well-lit photos where your face isn't covered (a phone in a mirror shot, sunglasses) work best.";
    setMeNote(
      found.length === files.length
        ? `Found your face in all ${files.length}.`
        : found.length
          ? `Found your face in ${found.length} of ${files.length}. ${tip}`
          : `Couldn't find a face in those. ${tip}`,
    );
  }

  function resetMe() {
    setMe([]);
    saveMe([]);
    setMeNote("");
    setRefs([]);
  }

  // Group photo: only the person you tap counts toward your taste (-1: none of them).
  async function choose(item: Item, index: number) {
    if (!item.photo || !item.outfits || index === item.chosen) return;
    const res = await fetch(`/api/upload/choose?k=${k}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ photo: item.photo, outfit: index }),
    }).catch(() => null);
    if (!res?.ok) return update(item.id, { error: res?.status === 403 ? STALE : "Couldn't save that. Try again." });
    const garments = index < 0 ? [] : item.outfits[index].garments;
    setCounts((c) => ({ ...c, garments: c.garments - item.garments.length + garments.length }));
    update(item.id, { chosen: index, garments, error: undefined });
  }

  async function onPick(chosen: FileList | null) {
    if (!chosen?.length) return;
    const picked = Array.from(chosen).map((file) => ({
      file,
      item: { id: nextId.current++, name: file.name, preview: URL.createObjectURL(file), state: "waiting" as const, garments: [] } as Item,
    }));
    picked.forEach((p) => files.current.set(p.item.id, p.file));
    setItems((all) => [...picked.map((p) => p.item), ...all]);
    await run(picked);
  }

  async function build() {
    setBuilding(true);
    setBuildError("");
    try {
      const res = await fetch(`/api/upload/build?k=${k}`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setProfile({ brief: json.brief.split("\n\nStyle pillars:")[0], pillars: json.pillars, searches: json.searches, builtFrom: json.photos });
    } catch (err) {
      setBuildError((err as Error).message);
    } finally {
      setBuilding(false);
    }
  }

  async function saveDetails(e: React.FormEvent) {
    e.preventDefault();
    setSavedDetails("Saving…");
    const res = await fetch(`/api/upload/details?k=${k}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sizes: { tops: details.tops, bottoms: details.bottoms, shoes: details.shoes, baggy: details.baggy },
        budget: { usualMax: details.usualMax, grailMax: details.grailMax },
        location: { zip: details.zip, radiusMi: details.radiusMi },
        brands: details.brands.split(/[,\n]/).map((b) => b.trim()).filter(Boolean),
      }),
    });
    setSavedDetails(res.ok ? (details.brands.trim() ? "Saved. Rebuild your profile to work the brands into its searches." : "Saved") : res.status === 403 ? STALE : "Couldn't save");
  }

  const active = items.filter((i) => i.state === "uploading" || i.state === "waiting").length;
  const uploaded = items.filter((i) => i.id >= 0);
  const done = uploaded.filter((i) => i.state === "done").length;
  const failed = uploaded.filter((i) => i.state === "error").length;
  const field = (key: "tops" | "bottoms" | "shoes" | "usualMax" | "grailMax" | "zip" | "radiusMi", label: string, type = "text", placeholder = "") => (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        inputMode={type === "number" ? "numeric" : undefined}
        value={details[key]}
        placeholder={placeholder}
        onChange={(e) => setDetails((d) => ({ ...d, [key]: type === "number" ? Number(e.target.value) : e.target.value }))}
      />
    </label>
  );

  return (
    <main className="up">
      <p className="eyebrow">
        fitscout · <a href={`/a/${k}`}>open your finds →</a>
      </p>
      <h1>Add photos of clothes you love</h1>
      <p className="lede">
        Outfits you wore, fits you saved, screenshots. Aim for about 100. Each one is analyzed as it uploads. Group photos are fine: only your
        outfit counts.
      </p>

      <p className="counts">
        <strong>{counts.photos}</strong> photos · <strong>{counts.garments}</strong> garments
      </p>

      <section className="card me">
        <h2>Find me in group photos</h2>
        <p className="note">
          {me.length
            ? `Matching your face from ${me.length} photo${me.length === 1 ? "" : "s"}. `
            : "Optional. Add 3 to 5 clear photos of just you, and group photos will pick you out automatically. "}
          The matching happens on this phone; these photos aren&apos;t uploaded.
        </p>
        <label className="pick small">
          <input type="file" accept="image/*" multiple onChange={(e) => addMe(e.target.files)} />
          {me.length ? "Add more photos of me" : "Add photos of me"}
        </label>
        {me.length > 0 && (
          <button type="button" className="secondary" onClick={resetMe}>
            Forget my face
          </button>
        )}
        {meNote && <p className="note">{meNote}</p>}
        {refs.length > 0 && (
          <ul className="refs">
            {refs.map((r, i) => (
              <li key={i} className={r.problem ? "bad" : "ok"}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={r.preview} alt="" />
                <span>{r.problem ?? "✓ face found"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <label className="pick">
        <input type="file" accept="image/*" multiple onChange={(e) => onPick(e.target.files)} />
        Choose photos
      </label>
      {uploaded.length > 0 && (
        <p className="progress">
          {active ? `Uploading… ${done} of ${uploaded.length} done` : `Done: ${done} of ${uploaded.length} uploaded`}
          {failed > 0 && !active && (
            <>
              {" "}
              <button type="button" className="secondary retry" onClick={retryFailed}>
                Retry {failed} failed
              </button>
            </>
          )}
        </p>
      )}

      {items.length > 0 && (
        <ul className="grid">
          {items.map((it) => {
            const group = (it.outfits?.length ?? 0) > 1;
            return (
              <li key={it.id} className={`tile ${it.state}${group ? " group" : ""}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={it.preview} alt="" />
                <span className="badge">{it.state === "done" ? "✓" : it.state === "error" ? "!" : "…"}</span>
                {group ? (
                  <div className="who">
                    <p className="ask">{it.found ? "Found you. Tap someone else if that's wrong." : `${it.outfits!.length} people. Which one is you?`}</p>
                    {it.outfits!.map((o, i) => (
                      <button key={i} type="button" className={i === it.chosen ? "on" : ""} onClick={() => choose(it, i)}>
                        <strong>{o.position.charAt(0).toUpperCase() + o.position.slice(1)}</strong> {o.outfit}
                      </button>
                    ))}
                    <button type="button" className={it.chosen === -1 ? "on" : ""} onClick={() => choose(it, -1)}>
                      None of them
                    </button>
                    {it.error && <p className="error">{it.error}</p>}
                  </div>
                ) : (
                  <p>{it.state === "error" ? it.error : it.garments.join(", ") || (it.state === "done" ? "no clothes found" : "")}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <section className="card">
        <h2>Your details</h2>
        <form onSubmit={saveDetails}>
          <div className="row">
            {field("tops", "Tops", "text", "L/XL")}
            {field("bottoms", "Bottoms", "text", "32x32")}
            {field("shoes", "Shoes", "text", "10")}
          </div>
          <label className="check">
            <input type="checkbox" checked={details.baggy} onChange={(e) => setDetails((d) => ({ ...d, baggy: e.target.checked }))} />
            I wear pants baggy (waist up to +2 is fine)
          </label>
          <label className="field wide">
            <span>Brands I wear or like</span>
            <input
              type="text"
              value={details.brands}
              placeholder="Ralph Lauren, Carhartt, Nike"
              onChange={(e) => setDetails((d) => ({ ...d, brands: e.target.value }))}
            />
          </label>
          <div className="row">
            {field("usualMax", "Usual max $", "number")}
            {field("grailMax", "Grail max $", "number")}
          </div>
          <div className="row">
            {field("zip", "Zip", "text", "27708")}
            {field("radiusMi", "Radius mi", "number")}
          </div>
          <button type="submit" className="secondary">Save details</button> <span className="note">{savedDetails}</span>
        </form>
      </section>

      <section className="card">
        <h2>Your taste profile</h2>
        <p className="note">
          {profile.builtFrom ? `Built from ${profile.builtFrom} photos.` : "Not built yet."}
          {counts.photos > profile.builtFrom ? ` ${counts.photos - profile.builtFrom} new photos since.` : ""}
        </p>
        <button className="primary" disabled={building || counts.photos < 5 || active > 0} onClick={build}>
          {building ? "Building… about a minute" : profile.builtFrom ? "Rebuild my profile" : "Build my profile"}
        </button>
        {counts.photos < 5 && <p className="note">Upload at least 5 photos first.</p>}
        {buildError && <p className="error">{buildError}</p>}
        {profile.brief && <p className="brief">{profile.brief}</p>}
        {profile.pillars.length > 0 && (
          <ul className="pillars">
            {profile.pillars.map((p) => (
              <li key={p.name}>
                <strong>{p.name}</strong> {p.description}
              </li>
            ))}
          </ul>
        )}
        {profile.searches.length > 0 && <p className="note">Scout searches: {profile.searches.slice(0, 12).join(" · ")}</p>}
      </section>
    </main>
  );
}
