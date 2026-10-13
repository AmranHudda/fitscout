import assert from "node:assert/strict";
import { test } from "node:test";

process.env.FITSCOUT_TOKEN = "test-secret";
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;

const { sign, verify, tokenMatches } = await import("../lib/sign");
const { dealRatio, prefilter, score, shouldNotify } = await import("../lib/pipeline");
const { mapEbayItem } = await import("../lib/sources/ebay");
const { emptyTaste, renderBrief, renderFeedback } = await import("../lib/taste");
const store = await import("../lib/store");
const { pushMessage } = await import("../lib/notify");

const taste = { ...emptyTaste(), brief: "Boxy 90s workwear.", budget: { usualMax: 150, grailMax: 400 } };
const verdict = (taste: number, extra: object = {}) => ({
  taste,
  match: null as number | null,
  why: "x",
  item: "jacket",
  brand: null,
  brandEvidence: null,
  sizeOk: "unknown" as const,
  pillar: null,
  flags: [],
  estValueUsd: null,
  model: "m",
  detail: "low" as const,
  judgedAt: "",
  ...extra,
});
const find = (price: number | null, v: ReturnType<typeof verdict>, ratio: number | null = null, mode: "scout" | "hunt" = "scout") => ({
  mode,
  id: "ebay:1",
  source: "ebay" as const,
  sourceId: "1",
  url: "https://example.com/1",
  title: "Jacket",
  price,
  currency: "USD",
  images: ["https://example.com/1.jpg"],
  firstSeen: new Date().toISOString(),
  via: "test",
  verdict: v,
  dealRatio: ratio,
});

test("signed rating links verify only for the same id and rating", () => {
  const s = sign("ebay:1:like");
  assert.ok(verify("ebay:1:like", s));
  assert.ok(!verify("ebay:1:dislike", s));
  assert.ok(!verify("ebay:2:like", s));
  assert.ok(!verify("ebay:1:like", s, ""));
});

test("token check is exact and rejects empty secrets", () => {
  assert.ok(tokenMatches("test-secret"));
  assert.ok(!tokenMatches("test-secre"));
  assert.ok(!tokenMatches(null));
  assert.ok(!tokenMatches("", ""));
});

test("prefilter drops over-budget and untitled listings", () => {
  assert.equal(prefilter({ ...find(500, verdict(9)), title: "x" }, taste), "over grail budget");
  assert.equal(prefilter({ ...find(50, verdict(9)), title: " " }, taste), "no title");
  assert.equal(prefilter(find(null, verdict(9)), taste), null);
});

test("notify rules: 8+, or 7 that is a steal; never wrong size; grails only above usual budget", () => {
  assert.ok(shouldNotify(find(80, verdict(8)), taste));
  assert.ok(!shouldNotify(find(80, verdict(7.5)), taste));
  assert.ok(shouldNotify(find(40, verdict(7.2), 0.4), taste));
  assert.ok(!shouldNotify(find(40, verdict(9, { sizeOk: "no" })), taste));
  assert.ok(!shouldNotify(find(200, verdict(8.5)), taste));
  assert.ok(shouldNotify(find(200, verdict(9.2)), taste));
});

const hunt = {
  id: "h1",
  want: "brown Carhartt Detroit jacket, blanket lined",
  queries: ["carhartt detroit jacket brown"],
  size: "M",
  maxPrice: 120,
  notes: null,
  active: true,
  createdAt: "",
  lastRunAt: null,
  matches: 0,
};

test("hunts: ranked by match, pinged at 8+ within their max price, never in the wrong size", () => {
  const f = (price: number, match: number, extra: object = {}) => find(price, verdict(3, { match, ...extra }), null, "hunt");
  assert.equal(score(f(100, 8.5)), 8.5);
  assert.equal(score(find(100, verdict(6))), 6);
  assert.ok(shouldNotify(f(100, 8.5), taste, hunt));
  assert.ok(!shouldNotify(f(100, 7.5), taste, hunt));
  assert.ok(!shouldNotify(f(130, 9), taste, hunt));
  assert.ok(!shouldNotify(f(100, 9, { sizeOk: "no" }), taste, hunt));
});

test("hunt prefilter leaves 25% room over the max for offers, ignores the scout budget", () => {
  assert.equal(prefilter({ ...find(145, verdict(9)), title: "x" }, taste, hunt), null);
  assert.equal(prefilter({ ...find(160, verdict(9)), title: "x" }, taste, hunt), "over hunt budget");
  assert.equal(prefilter({ ...find(450, verdict(9)), title: "x" }, taste, { ...hunt, maxPrice: null }), null);
});

test("deal ratio needs both a price and a positive estimate", () => {
  assert.equal(dealRatio(40, verdict(8, { estValueUsd: 200 })), 0.2);
  assert.equal(dealRatio(null, verdict(8, { estValueUsd: 200 })), null);
  assert.equal(dealRatio(40, verdict(8, { estValueUsd: 0 })), null);
});

test("eBay items map to listings, auctions use the current bid, images are upsized", () => {
  const l = mapEbayItem({
    itemId: "v1|123|0",
    title: "Vintage Carhartt Detroit Jacket",
    itemWebUrl: "https://www.ebay.com/itm/123",
    price: { value: "120.00", currency: "USD" },
    currentBidPrice: { value: "41.00", currency: "USD" },
    image: { imageUrl: "https://i.ebayimg.com/images/g/abc/s-l225.jpg" },
    buyingOptions: ["AUCTION"],
    bidCount: 3,
    itemEndDate: "2026-10-13T00:00:00Z",
    itemLocation: { city: "Durham", stateOrProvince: "NC" },
  });
  assert.equal(l.id, "ebay:v1|123|0");
  assert.equal(l.price, 41);
  assert.equal(l.format, "auction");
  assert.equal(l.images[0], "https://i.ebayimg.com/images/g/abc/s-l1600.jpg");
  assert.equal(l.location, "Durham, NC");
});

test("seen is per scope, and a scout pick never overwrites a hunt match", async () => {
  assert.ok(await store.markSeen("ebay:z", "scout"));
  assert.ok(await store.markSeen("ebay:z", "h1"));
  assert.ok(!(await store.markSeen("ebay:z", "h1")));

  await store.saveFind({ ...find(100, verdict(3, { match: 9 }), null, "hunt"), id: "ebay:z", huntId: "h1" });
  await store.saveFind({ ...find(100, verdict(8)), id: "ebay:z" });
  assert.equal((await store.getFind("ebay:z"))?.mode, "hunt");
});

test("memory store: seen-once, feed order, rating feeds back into prompts", async () => {
  assert.ok(await store.markSeen("ebay:a"));
  assert.ok(!(await store.markSeen("ebay:a")));
  await store.unmarkSeen("ebay:a");
  assert.ok(await store.markSeen("ebay:a"));

  const older = { ...find(50, verdict(8)), id: "ebay:old", firstSeen: new Date(Date.now() - 60_000).toISOString() };
  const newer = { ...find(60, verdict(9)), id: "ebay:new" };
  await store.saveFind(older);
  await store.saveFind(newer);
  const recent = await store.recentFinds(Date.now() - 3_600_000);
  assert.deepEqual(recent.map((f) => f.id).filter((id) => id === "ebay:new" || id === "ebay:old"), ["ebay:new", "ebay:old"]);

  await store.rateFind("ebay:old", "dislike", "too cropped");
  const fb = await store.recentFeedback();
  assert.equal(fb[0].note, "too cropped");
  assert.match(renderFeedback(fb), /did NOT want[\s\S]*too cropped/);
});

test("brief renders sizes and budget even before photos are ingested", () => {
  const t = { ...emptyTaste(), sizes: { tops: "M", bottoms: "32x32", shoes: null, notes: null } };
  const b = renderBrief(t);
  assert.match(b, /Sizes: tops M; bottoms 32x32\./);
  assert.match(b, /up to \$400 for a grail/);
});

test("push message carries signed 👍/👎 actions and the listing link", () => {
  const msg = pushMessage(find(40, verdict(8.5), 0.3));
  assert.equal(msg.click, "https://example.com/1");
  const like = msg.actions.find((a) => a.label.includes("👍"))!;
  const u = new URL(like.url);
  assert.equal(u.searchParams.get("r"), "like");
  assert.ok(verify(`ebay:1:like`, u.searchParams.get("s")!));
  assert.ok(msg.tags.includes("moneybag"));
});

test("hunt pushes say what they asked for", () => {
  const msg = pushMessage(find(100, verdict(3, { match: 9 }), null, "hunt"), hunt);
  assert.match(msg.title, /^Hunt match 9\/10/);
  assert.match(msg.message, /You asked for: brown Carhartt Detroit jacket/);
  assert.ok(msg.tags.includes("dart"));
});

test("Grailed hits map to listings; non-US-shipping listings are skipped", async () => {
  const { mapGrailedHit } = await import("../lib/sources/grailed");
  const l = mapGrailedHit({
    id: 108581807,
    title: "VINTAGE Carhartt Detroit J97",
    price_i: 384,
    size: "xl",
    designer_names: "Carhartt",
    condition: "is_used",
    cover_photo: { url: "https://media-assets.grailed.com/x" },
    shipping: { us: { amount: 19, enabled: true } },
  })!;
  assert.equal(l.id, "grailed:108581807");
  assert.equal(l.url, "https://www.grailed.com/listings/108581807");
  assert.equal(l.condition, "Used");
  assert.match(l.description!, /\$19/);
  assert.equal(mapGrailedHit({ id: 1, title: "x", price_i: 1, shipping: { us: { amount: 0, enabled: false } } }), null);
});

test("deal ratio prefers real sold comps over the model's estimate", () => {
  assert.equal(dealRatio(100, verdict(8, { estValueUsd: 1000 }), 200), 0.5);
  assert.equal(dealRatio(100, verdict(8, { estValueUsd: 400 }), null), 0.25);
});

test("upload key is plain hex (survives copy/paste) and checked exactly", async () => {
  const { uploadKey, uploadKeyOk, uploadLink } = await import("../lib/uploads");
  const key = uploadKey();
  assert.match(key, /^[0-9a-f]{24}$/);
  assert.ok(uploadKeyOk(key));
  assert.ok(!uploadKeyOk(key.slice(0, -1)));
  assert.ok(!uploadKeyOk(null));
  assert.ok(uploadLink().endsWith(`/u/${key}`));
});

test("pages opened from the first-version upload link keep working", async () => {
  const { uploadKeyOk } = await import("../lib/uploads");
  assert.ok(uploadKeyOk(sign("upload")));
  assert.ok(!uploadKeyOk(sign("upload").slice(0, -1)));
});

test("in a group photo only the person you pick counts", async () => {
  const item = (name: string) => ({ name, part: "upperbody" as const, category: "shirt", colorName: "black", color: "#000000", secondaryColor: null, material: null, fit: null, pattern: null, era: null, brand: null, standout: false, tags: [], queries: [] });
  const photo = "inspo/group-test.jpg";
  const outfits = [
    { position: "left", outfit: "friend's red puffer", main: false, garments: [item("red puffer")] },
    { position: "center", outfit: "black camp shirt", main: true, garments: [item("black camp shirt"), item("pleated trousers")] },
  ];
  await store.addGarmentRow({ photo, original: "IMG_1.jpg", garments: outfits[1].garments, outfits, chosen: 1, at: new Date().toISOString() });
  const row = async () => (await store.garmentRows()).find((r) => r.photo === photo)!;
  assert.deepEqual((await row()).garments.map((g) => g.name), ["black camp shirt", "pleated trousers"]);

  const { pickOutfit } = await import("../lib/uploads");
  assert.deepEqual((await pickOutfit(photo, 0))?.map((g) => g.name), ["red puffer"]);
  assert.deepEqual((await row()).garments.map((g) => g.name), ["red puffer"]);
  assert.deepEqual(await pickOutfit(photo, -1), []);
  assert.equal((await row()).garments.length, 0);
  assert.equal(await pickOutfit(photo, 5), null);
  assert.equal(await pickOutfit("inspo/nope.jpg", 0), null);
});

test("sizes read as the judge should take them: L/XL is either, baggy runs +2 waist", async () => {
  const { renderSizes } = await import("../lib/taste");
  const s = { tops: "L/XL", bottoms: "32x32", shoes: "11", notes: null };
  assert.equal(renderSizes(s), "tops L/XL (any of these fit); bottoms 32x32; shoes 11");
  assert.equal(renderSizes({ ...s, baggy: true }), "tops L/XL (any of these fit); bottoms 32x32, worn baggy: waist 32, 33, or 34 all fit (same length); shoes 11");
  assert.equal(renderSizes({ ...s, bottoms: "M", baggy: true }), "tops L/XL (any of these fit); bottoms M, worn baggy: a size or two up also fits; shoes 11");
});

test("brands they list are kept, shown to the judge, and survive a details save without them", async () => {
  const { saveDetails } = await import("../lib/uploads");
  let t = await saveDetails({ brands: [" Carhartt ", "Ralph Lauren", "Carhartt", ""] });
  assert.deepEqual(t.myBrands, ["Carhartt", "Ralph Lauren"]);
  assert.match(renderBrief(t), /Brands they say they wear or like: Carhartt, Ralph Lauren\./);
  t = await saveDetails({ sizes: { tops: "L/XL" } });
  assert.deepEqual(t.myBrands, ["Carhartt", "Ralph Lauren"]);
});

test("app notifications open the find in the app, with the same text as ntfy", async () => {
  const { webPushMessage } = await import("../lib/notify");
  const msg = webPushMessage(find(40, verdict(8.5), 0.3));
  assert.match(msg.title, /8.5\/10 · \$40/);
  assert.match(msg.url, /\/a\/[0-9a-f]{24}#/);
  assert.ok(msg.url.endsWith(encodeURIComponent(find(40, verdict(8.5), 0.3).id)));
  assert.equal(msg.tag, find(40, verdict(8.5), 0.3).id);
});

test("push subscriptions are stored once per endpoint and can be removed", async () => {
  const sub = { endpoint: "https://web.push.apple.com/test-endpoint", keys: { p256dh: "p", auth: "a" } };
  await store.savePushSub(sub);
  await store.savePushSub(sub);
  assert.equal((await store.listPushSubs()).filter((s) => s.endpoint === sub.endpoint).length, 1);
  await store.removePushSub(sub.endpoint);
  assert.equal((await store.listPushSubs()).filter((s) => s.endpoint === sub.endpoint).length, 0);
});

test("Grailed searches drop 'mens', which Grailed titles rarely include", async () => {
  const { grailedQuery } = await import("../lib/sources/grailed");
  assert.equal(grailedQuery("black wool overcoat mens single breasted"), "black wool overcoat single breasted");
  assert.equal(grailedQuery("Men's Carhartt jacket"), "Carhartt jacket");
  assert.equal(grailedQuery("womens"), "womens");
});

test("the judge sees what's already in their photos, so near-copies aren't sold back to them", async () => {
  const { ownedFrom } = await import("../lib/uploads");
  const owned = ownedFrom([{ name: "black Polo quarter-zip" }, { name: "Black Polo Quarter-Zip" }, { name: "cream waffle henley" }]);
  assert.deepEqual(owned, ["Black Polo Quarter-Zip", "cream waffle henley"]);
  const t = { ...taste, owned };
  assert.match(renderBrief(t, { forPrompt: true }), /Already in their photos \(they have these; a near-copy is not a find\): Black Polo Quarter-Zip; cream waffle henley\./);
  assert.doesNotMatch(renderBrief(t), /Already in their photos/);
});
