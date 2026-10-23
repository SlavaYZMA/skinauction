// Skin Auction API: bidder registration (paddle numbers), bids, public board.
// Public data = paddle number, amount, time. Names and contacts stay private in the blob store.
import { getStore } from "@netlify/blobs";
import LOTS from "../../public/assets/lots.json" with { type: "json" };

// AUCTION_OPEN / AUCTION_CLOSE env vars (ISO dates) override the schedule, e.g. for a test round.
export const OPEN = Date.parse(process.env.AUCTION_OPEN || "2026-11-30T00:00:00+01:00");
export const CLOSE = Date.parse(process.env.AUCTION_CLOSE || "2026-12-06T20:00:00+01:00");

const json = (o, status = 200, extra = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
export const step = (v) => Math.max(10, Math.ceil((v * 0.05) / 5) * 5);
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);
const norm = (c) => c.trim().toLowerCase().replace(/^https?:\/\/(www\.)?instagram\.com\//, "").replace(/^@/, "").replace(/[/?#].*$/, "");
const yes = (v) => v === true || v === "yes" || v === "on";
async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Append-only storage: every bid is its own key, so concurrent bids never overwrite each other.
// Key: bid/<lot>/<amount, 9 digits>-<time ms>-<paddle>
const bidKey = (lot, v, t, num) => `bid/${lot}/${String(v).padStart(9, "0")}-${t}-${num}`;
async function lotBids(store, lot) {
  const { blobs } = await store.list({ prefix: `bid/${lot}/` });
  return blobs
    .map(({ key }) => { const [v, t, num] = key.split("/")[2].split("-").map(Number); return { num, v, t }; })
    .sort((a, b) => b.v - a.v || a.t - b.t);
}

// Ceiling bids (secret maximum, like an absentee bid at an auction house).
// Key: max/<lot>/<paddle> → { v, t, name, contact }. Only the resulting bids are ever public.
const maxKey = (lot, num) => `max/${lot}/${num}`;
async function lotMaxes(store, lot) {
  const { blobs } = await store.list({ prefix: `max/${lot}/` });
  const out = [];
  for (const { key } of blobs) {
    const m = await store.get(key, { type: "json" });
    if (m) out.push({ num: Number(key.split("/")[2]), v: m.v, t: m.t });
  }
  return out;
}

// After any bid or new ceiling: let ceilings answer, eBay style.
// A = bidder with the highest ceiling (earliest wins a tie), B = the next one.
// B's ceiling bids as high as A can still beat by one step; then A takes the lead
// at one step above B's ceiling, capped at A's own ceiling.
export async function resolve(store, lot, now = Date.now()) {
  const maxes = await lotMaxes(store, lot.no);
  if (!maxes.length) return;
  let bids = await lotBids(store, lot.no);
  const ceil = new Map();
  for (const b of bids) {
    const e = ceil.get(b.num) || { num: b.num, c: 0, t: b.t, best: 0, proxy: false };
    e.best = Math.max(e.best, b.v); e.c = Math.max(e.c, b.v); e.t = Math.min(e.t, b.t);
    ceil.set(b.num, e);
  }
  for (const m of maxes) {
    const e = ceil.get(m.num) || { num: m.num, c: 0, t: m.t, best: 0, proxy: false };
    if (m.v >= e.c) { e.c = m.v; e.proxy = true; e.t = Math.min(e.t, m.t); }
    ceil.set(m.num, e);
  }
  const ranked = [...ceil.values()].filter((e) => e.c >= (lot.start || 0)).sort((a, b) => b.c - a.c || a.t - b.t);
  const A = ranked[0], B = ranked[1];
  if (!A) return;
  const minNext = (top) => (top ? top.v + step(top.v) : lot.start);
  let t = now;
  const put = async (num, v) => {
    await store.setJSON(bidKey(lot.no, v, t, num), { auto: true }, { onlyIfNew: true });
    t += 1;
    bids = await lotBids(store, lot.no);
  };
  // B's ceiling answers first (only a secret ceiling bids by itself).
  if (B && B.proxy) {
    let x = B.c;
    while (x > 0 && x + step(x) > A.c) x--;
    if (x > B.best && x >= minNext(bids[0])) await put(B.num, x);
  }
  // A takes or keeps the lead.
  if (A.proxy && bids[0]?.num !== A.num) {
    const target = Math.max(minNext(bids[0]), B ? Math.min(A.c, B.c + step(B.c)) : 0);
    if (target <= A.c) await put(A.num, target);
  }
}

// Soft close: a bid in the last 2 minutes of a lot extends that lot by 2 minutes from the bid.
// Derived from the bid times themselves, so no extra state can drift.
export const EXT = 120_000;
export function lotClose(bids) {
  let close = CLOSE;
  for (const b of [...bids].sort((x, y) => x.t - y.t)) {
    if (b.t > close) break;
    if (b.t > close - EXT) close = b.t + EXT;
  }
  return close;
}

export async function register(store, b) {
  const name = clean(b.name, 40), country = clean(b.country, 40), contact = clean(b.contact, 80);
  if (!name || !contact) return { error: "Add a name and your Instagram or email." };
  if (!yes(b.age_21) || !yes(b.rules)) return { error: "Confirm that you are 21+ and accept the rules." };
  const h = await sha(norm(contact));
  const known = await store.get("bidder/" + h, { type: "json" });
  if (known) return { num: known.num, isNew: false };
  for (let i = 0; i < 60; i++) {
    const num = 100 + Math.floor(Math.random() * 900);
    const claim = await store.setJSON("num/" + num, { h }, { onlyIfNew: true });
    if (!claim.modified) continue;
    const w = await store.setJSON("bidder/" + h, { num, name, country, contact, created: new Date().toISOString() }, { onlyIfNew: true });
    if (!w.modified) {
      await store.delete("num/" + num);
      const e = await store.get("bidder/" + h, { type: "json" });
      return { num: e.num, isNew: false };
    }
    // Country goes into the key only as an ISO code, so the board can count countries without reading bidder records.
    const cc = /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : "";
    await store.setJSON(`reg/${Date.now()}-${num}${cc ? "-" + cc : ""}`, {}, { onlyIfNew: true });
    return { num, isNew: true };
  }
  return { error: "Could not assign a paddle number. Try again." };
}

export async function board(store, now = Date.now()) {
  const { blobs } = await store.list({ prefix: "num/" });
  const lots = {};
  for (const l of LOTS) {
    const bids = await lotBids(store, l.no);
    lots[l.no] = { count: bids.length, bidders: new Set(bids.map((x) => x.num)).size, close: lotClose(bids), bids: bids.slice(0, 12) };
  }
  const all = (await store.list({ prefix: "reg/" })).blobs
    .map(({ key }) => { const [t, num, cc] = key.slice(4).split("-"); return { num: Number(num), t: Number(t), cc: cc || "" }; });
  const countries = new Set(all.map((r) => r.cc).filter(Boolean)).size;
  const regs = all.sort((a, b) => b.t - a.t).slice(0, 20).map(({ num, t }) => ({ num, t }));
  return { now, open: OPEN, close: CLOSE, bidders: blobs.length, countries, regs, lots };
}

export async function bid(store, b, now = Date.now()) {
  if (now < OPEN) return { error: "Bidding opens on 30 November. Register now to get your paddle number.", status: 409 };
  const lot = LOTS.find((l) => l.no === String(b.lot));
  if (!lot) return { error: "Unknown lot.", status: 400 };
  if (!lot.start) return { error: "The start price for this lot is not set yet.", status: 409 };
  const amount = Math.round(Number(b.amount));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 999_999_999) return { error: "Enter a bid in whole euros.", status: 400 };
  const reg = await register(store, b);
  if (reg.error) return { ...reg, status: 400 };
  const before = await lotBids(store, lot.no);
  if (now > lotClose(before)) return { error: "Bidding on this lot has closed.", status: 409 };
  const top = before[0]?.v;
  const min = top ? top + step(top) : lot.start;
  if (amount < min) return { error: `Bid at least €${min}.`, min, status: 409 };
  if (yes(b.ceiling)) {
    // Secret ceiling: nothing public is written here; resolve() places the bids it needs.
    await store.setJSON(maxKey(lot.no, reg.num), { v: amount, t: now, name: clean(b.name, 40), contact: clean(b.contact, 80) });
  } else {
    await store.setJSON(bidKey(lot.no, amount, now, reg.num), { name: clean(b.name, 40), contact: clean(b.contact, 80) }, { onlyIfNew: true });
  }
  await resolve(store, lot, now + 1);
  const bids = await lotBids(store, lot.no);
  return { ok: true, num: reg.num, lot: lot.no, lead: bids[0]?.num === reg.num, ceiling: yes(b.ceiling) ? amount : null, count: bids.length, close: lotClose(bids), bids: bids.slice(0, 12) };
}

export default async (req) => {
  const store = getStore({ name: "auction", consistency: "strong" });
  const path = new URL(req.url).pathname;
  try {
    if (path === "/api/board" && req.method === "GET")
      return json(await board(store), 200, { "netlify-cdn-cache-control": "public, s-maxage=2, stale-while-revalidate=4" });
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const b = await req.json().catch(() => ({}));
    if (b["bot-field"]) return json({ ok: true });
    if (path === "/api/register") {
      const r = await register(store, b);
      return json(r, r.error ? 400 : 200);
    }
    if (path === "/api/bid") {
      const r = await bid(store, b);
      const { status, ...rest } = r;
      return json(rest, status || 200);
    }
    return json({ error: "Not found" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: "Server error. Try again." }, 500);
  }
};

export const config = { path: ["/api/board", "/api/register", "/api/bid"] };
