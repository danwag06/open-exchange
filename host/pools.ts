// The Open Exchange's pool reads and pool event feeds (0.11.0, the public read API; plans: D11, D13, D22;
// 0.14.0: the pool id, the price, the validator minimum, the feeds), answered by the HOST through skein's
// Router options `appRead` and `appEvent` — the routes that join what only the host holds (the beats it
// keeps per topic, every enabled token instance) to a token instance's pool index:
//
//   GET /@<tokenId>/amm/pools   {market, validators: [{identity, peerId, minLegSats?}], pools: [{poolId, lpPubKey,
//                                outpoint, bsvReserve, tokenReserve, liquidityFeeBps, validationFeeBps, commissionBps,
//                                validatorIdentityKey, validatorPeerId, swaps}]}   a plain read (0.14.0: no event stream)
//       the instance's pools (its lookup ls_amm_<tokenId>, query {tokenId}) whose validator is beating
//       on tm_color_<tokenId>-live now (the host's liveness table; the peer ID is the beat's `from`) AND
//       whose commissionBps is at least the instance's market minimum; `market` = the instance's own
//       answer at GET /amm/terms (`market`: {commissionPkh, minCommissionBps}); `validators` = every
//       validator beating on tm_color_<tokenId>-live now (identity hex, peer ID the beat's `from`, and
//       0.14.0 `minLegSats` = the beat body's `terms.minLegSats` when its terms carry one), whatever its pools.
//   GET <origin>/amm/pools      [{tokenId, …the row above}]   every enabled token instance's, one array.
//   GET /@<tokenId>/amm/stats   the instance's own `/stats` row with `tvlSats`, `tvlTokens` and `pools` the sums and
//                                the count over the pools GET /@<id>/amm/pools lists; 0.14.0: `price` = the engine's
//                                `priceOf(those pools).mid`, `buyPrice` / `sellPrice` its buy and sell (null with no
//                                pool); `change1h` / `change24h` = the change in bps (truncated toward zero) from
//                                `priceOf(GET /pools/at?t=now − 1 h | 24 h).mid` to `price` (null when either is none);
//                                `lastTradePrice`, the volumes, `lastTradeAt` the instance's.
//   GET <origin>/amm/stats      [<a token's GET /@<id>/amm/stats>]   every enabled token's, one array; `?ids=a,b` those
//                                enabled tokens only, in the query's order.
//   GET /@<tokenId>/amm/candles?series=market&tf=&from=&to=   (0.14.0) the market-price candles: the pools at `from`
//                                (`/pools/at?t=from − 1`: the state entering the window), the events of the window
//                                (`/pools/history?from&to`, paged by `next`), the price (`priceOf(pools).mid`) after
//                                each event; a bucket of `tf` exists when it holds an event: `o` the price entering
//                                its first event, `c` after its last, `h` / `l` over those, `volumeSats` /
//                                `volumeTokens` / `n` from its swaps. Without `series` or `series=fill`: the
//                                instance's own answer (forwarded).
//   GET <origin>/amm/positions?pool=id1,id2   [{tokenId, …a row of GET /@<id>/amm/positions?pool=}]   every enabled
//                                token's rows for the pool ids.
//   GET <origin>/amm/spends?outpoint=a,b      (0.14.0) [{outpoint, tokenId?, spentBy?}]   one record per outpoint in
//                                query order: each enabled token's `/spends`, the first that names a spender.
//   GET /@<tokenId>/amm/events, GET <origin>/amm/events   (0.14.0) Server-Sent Events: each message `event: pool`,
//                                `data: {"tokenId": …, …row}` — the token instance's emitted `pool` event (its
//                                lookup's, app `amm`: `{event: "pool", topic, tokenId, row}`), its `tokenId` and
//                                `row` passed through untouched; the token feed that token's, the origin feed every
//                                enabled token's. Nothing is sent on connect, nothing is kept, nothing is replayed:
//                                a connection is a subscriber in a set, removed when it closes.
//
// The reads: `Cache-Control: public, max-age=5`; a token whose read fails is left out of a join (logged).
import { priceOf, type PoolState, type PricePair as Price } from "@dcasegr/amm-engine";
import { SWAP } from "./exchange.ts";
import type { Router } from "./skein.ts";

type RouterRequest = import("@dcasegr/skein/dist/host/router.js").RouterRequest;
type RouterResponse = import("@dcasegr/skein/dist/host/router.js").RouterResponse;
type Rec = Record<string, unknown>;

const TOKEN_ID = /^[0-9a-f]{64}_\d+$/;
/** The token app's name (its routes are /amm/…, its events' `app`). */
const APP = "amm";
/** The routes the host answers (at the token instance's, at swap's). */
export const POOLS_ROUTE = `/${APP}/pools`;
export const STATS_ROUTE = `/${APP}/stats`;
export const POSITIONS_ROUTE = `/${APP}/positions`;
export const SPENDS_ROUTE = `/${APP}/spends`;
export const CANDLES_ROUTE = `/${APP}/candles`;
export const EVENTS_ROUTE = `/${APP}/events`;
/** The emitted event the feeds pass through (the token instance's lookup's, skein-amm 0.41.0). */
export const POOL_EVENT = "pool";
const CACHE = "public, max-age=5";
const HOUR_MS = 3_600_000;
/** The candle resolutions (the instance's `/candles`), ms. */
const TIMEFRAMES: Record<string, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
/** The most buckets one candle window may span (the instance's `max_buckets`). */
const MAX_BUCKETS = 5000;
/** The page size `/pools/history` takes at most. */
const HISTORY_LIMIT = 500;

/** One pool as the routes answer it. */
export interface PoolRow {
  poolId: string; lpPubKey?: string; outpoint: string; bsvReserve: unknown; tokenReserve: unknown;
  liquidityFeeBps: unknown; validationFeeBps: unknown; commissionBps: unknown;
  validatorIdentityKey: string; validatorPeerId: string; swaps: unknown;
}
export interface Market { commissionPkh?: unknown; minCommissionBps?: unknown }
export interface Validator { identity: string; peerId: string; minLegSats?: number | bigint }
export interface TokenPools { market: Market; validators: Validator[]; pools: PoolRow[] }

const enc = (s: string) => new TextEncoder().encode(s);
/** JSON with bigints as JSON numbers, exactly (the price pairs exceed 2^53). */
export const toJson = (v: unknown): string => JSON.stringify(v, (_k, x) => typeof x === "bigint" ? (JSON as unknown as { rawJSON(t: string): unknown }).rawJSON(x.toString()) : x);
const jsonAnswer = (status: number, v: unknown, headers: Record<string, string> = {}): RouterResponse =>
  ({ status, headers: { "content-type": "application/json", ...headers }, body: enc(toJson(v)) });
const problem = (status: number, description: string) => jsonAnswer(status, { status: "error", code: status === 404 ? "ERR_NOT_FOUND" : status === 400 ? "ERR_BAD_REQUEST" : "ERR_UNAVAILABLE", description });
const num = (v: unknown) => typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
const big = (v: unknown): bigint => { try { return typeof v === "bigint" ? v : BigInt(v as number | string); } catch { return 0n; } };

/** A pool row (a listed pool, a `/pools/at` row, a history event's pool) as the engine's PoolState. */
export function poolState(p: Rec): PoolState {
  return {
    outpoint: String(p.outpoint), bsvReserve: big(p.bsvReserve), tokenReserve: big(p.tokenReserve),
    liquidityFeeBps: big(p.liquidityFeeBps), validationFeeBps: big(p.validationFeeBps), commissionBps: big(p.commissionBps),
    validatorIdentityKey: String(p.validatorIdentityKey),
  };
}

/** The change from `then` to `now` in bps, truncated toward zero (the instance's `changeBps`). */
export function changeBps(then: Price, now: Price): bigint {
  const n = now.sats * then.tokens - then.sats * now.tokens;
  const d = then.sats * now.tokens;
  return d === 0n ? 0n : (n * 10_000n) / d;
}

/** `a` < `b` as prices (sats per token). */
const lt = (a: Price, b: Price) => a.sats * b.tokens < b.sats * a.tokens;

/**
 * A token's stats row as this host answers it (0.14.0): the instance's `/stats` row with `tvlSats`, `tvlTokens`
 * and `pools` the sums and the count over `pools` (the listed pools), `price` / `buyPrice` / `sellPrice` =
 * `priceOf(pools)`'s mid / buy / sell (null with none), and `change1h` / `change24h` from the mids `then1h` /
 * `then24h` (the pools listed an hour and a day ago, `/pools/at`) to `price` (null when either is none).
 */
export function mergeStats(row: Rec, pools: PoolRow[], then1h: Price | null, then24h: Price | null): Rec {
  let sats = 0n, tokens = 0n;
  for (const p of pools) { sats += big(p.bsvReserve); tokens += big(p.tokenReserve); }
  const now = priceOf(pools.map((p) => poolState(p as unknown as Rec)));
  const price = now?.mid ?? null;
  return {
    ...row,
    price, buyPrice: now?.buy ?? null, sellPrice: now?.sell ?? null,
    change1h: price && then1h ? changeBps(then1h, price) : null,
    change24h: price && then24h ? changeBps(then24h, price) : null,
    tvlSats: sats, tvlTokens: tokens, pools: pools.length,
  };
}

/** One market candle (the instance's candle shape). */
export interface MarketCandle { t: number; o: Price; h: Price; l: Price; c: Price; volumeSats: bigint; volumeTokens: bigint; n: number }

/**
 * The market-price candles (0.14.0) over `start` (the pools entering the window, `/pools/at` rows) and `events`
 * (the window's `/pools/history` events, oldest first): each event applied by its pool id (a deploy or a swap
 * sets the pool's state from the event, a close or a rescind removes it), the price `priceOf(pools).mid` after
 * each; one candle per bucket of `tf` holding an event — `o` the price entering its first event, `c` after its
 * last, `h` / `l` over those (a price that is none is passed over; a bucket with none: no candle); the volumes and
 * `n` from its swaps (a buy: sats in, tokens out; a sell: tokens in, sats out; a swap moving no tokens counts
 * nothing, as the instance's candles).
 */
export function marketCandles(start: Rec[], events: Rec[], tf: number): MarketCandle[] {
  const pools = new Map<string, PoolState>();
  for (const p of start) pools.set(String(p.poolId), poolState(p));
  const mid = () => priceOf([...pools.values()])?.mid ?? null;
  const out: MarketCandle[] = [];
  let cur: { t: number; prices: Price[]; volumeSats: bigint; volumeTokens: bigint; n: number } | undefined;
  const close = () => {
    if (!cur || cur.prices.length === 0) return;
    let h = cur.prices[0]!, l = cur.prices[0]!;
    for (const p of cur.prices) { if (lt(h, p)) h = p; if (lt(p, l)) l = p; }
    out.push({ t: cur.t, o: cur.prices[0]!, h, l, c: cur.prices[cur.prices.length - 1]!, volumeSats: cur.volumeSats, volumeTokens: cur.volumeTokens, n: cur.n });
  };
  for (const ev of events) {
    const at = num(ev.at);
    const t = at - (at % tf);
    if (!cur || cur.t !== t) {
      close();
      const entering = mid();
      cur = { t, prices: entering ? [entering] : [], volumeSats: 0n, volumeTokens: 0n, n: 0 };
    }
    const id = String(ev.poolId);
    if (ev.kind === "deploy" || ev.kind === "swap") pools.set(id, poolState(ev));
    else if (ev.kind === "close" || ev.kind === "rescind") pools.delete(id);
    if (ev.kind === "swap") {
      const inn = big(ev.amountIn), outt = big(ev.amountOut);
      const [s, k] = ev.side === "buy" ? [inn, outt] : [outt, inn];
      if (k !== 0n) { cur.volumeSats += s; cur.volumeTokens += k; cur.n += 1; }
    }
    const after = mid();
    if (after) cur.prices.push(after);
  }
  close();
  return out;
}

class ReadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** A feed's connection: one message out. */
type Subscriber = (chunk: string) => void;

export class Pools {
  readonly router: Router;
  readonly say: (line: string) => void;
  /** dag-cbor decode (a beat's body). */
  private readonly decode: (bytes: Uint8Array) => unknown;
  /** The feeds' subscribers: per token instance, and the origin's (every token's). */
  private readonly feeds = new Map<string, Set<Subscriber>>();
  private readonly everyFeed = new Set<Subscriber>();
  /** Every open feed's end (the host stops). */
  private readonly ends = new Set<() => void>();

  constructor(router: Router, say: (line: string) => void, decode: (bytes: Uint8Array) => unknown) {
    this.router = router; this.say = say; this.decode = decode;
  }

  /** RouterOptions.appRead: the token routes at a token instance; the joins and the origin feed at swap; anything else undefined (forwarded). */
  async appRead(handle: string, route: string, url: URL, _req: RouterRequest): Promise<RouterResponse | undefined> {
    const q = url.searchParams;
    if (handle === SWAP) {
      if (route === EVENTS_ROUTE) return this.feed(this.everyFeed);
      if (route === POOLS_ROUTE) return jsonAnswer(200, await this.allPools(), { "cache-control": CACHE });
      if (route === STATS_ROUTE) return jsonAnswer(200, await this.allStats(q.get("ids")), { "cache-control": CACHE });
      if (route === POSITIONS_ROUTE) {
        const pool = q.get("pool");
        if (!pool) return problem(400, "want ?pool=<txid>_<vout>[,…]");
        return jsonAnswer(200, await this.allPositions(pool), { "cache-control": CACHE });
      }
      if (route === SPENDS_ROUTE) {
        const ops = (q.get("outpoint") ?? "").split(",").map((x) => x.trim()).filter((x) => x !== "");
        if (ops.length === 0) return problem(400, "want ?outpoint=<txid>.<vout>[,…]");
        return jsonAnswer(200, await this.allSpends(ops), { "cache-control": CACHE });
      }
      return undefined;
    }
    if (!TOKEN_ID.test(handle)) return undefined;
    if (route === EVENTS_ROUTE) {
      let set = this.feeds.get(handle);
      if (!set) { set = new Set(); this.feeds.set(handle, set); }
      return this.feed(set);
    }
    try {
      if (route === POOLS_ROUTE) return jsonAnswer(200, await this.tokenPools(handle), { "cache-control": CACHE });
      if (route === STATS_ROUTE) return jsonAnswer(200, await this.tokenStats(handle), { "cache-control": CACHE });
      if (route === CANDLES_ROUTE && q.get("series") === "market") return await this.candleAnswer(handle, q);
    } catch (e) {
      return problem(e instanceof ReadError ? e.status : 503, (e as Error).message);
    }
    return undefined;
  }

  /**
   * RouterOptions.appEvent's share (0.14.0): a token instance's emitted `pool` event (app `amm`), passed to its
   * token feed and the origin feed as `event: pool`, `data: {tokenId, …row}`. Returns whether it was one.
   */
  poolEvent(handle: string, rec: Rec): boolean {
    if (!TOKEN_ID.test(handle) || rec.app !== APP || rec.event !== POOL_EVENT) return false;
    const row = rec.row && typeof rec.row === "object" ? rec.row as Rec : {};
    const chunk = `event: ${POOL_EVENT}\ndata: ${toJson({ tokenId: rec.tokenId, ...row })}\n\n`;
    for (const s of this.feeds.get(handle) ?? []) s(chunk);
    for (const s of this.everyFeed) s(chunk);
    return true;
  }

  /** A feed's answer: held open; the connection a subscriber in `set` until it closes. */
  private feed(set: Set<Subscriber>): RouterResponse {
    return {
      status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }, body: new Uint8Array(),
      stream: (send, end) => {
        set.add(send);
        this.ends.add(end);
        return () => { set.delete(send); this.ends.delete(end); };
      },
    };
  }

  // ---------------------------------------------------------------- the reads

  /** An in-process request of the instance's own (`/@<handle>/amm/<path>`). */
  private async instanceRead(handle: string, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const r = this.router;
    const a = await r.dispatch({ method, url: `${r.origin()}/@${handle}/${APP}/${path}`, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? new Uint8Array() : enc(JSON.stringify(body)) });
    const text = new TextDecoder().decode(a.body);
    if (a.status !== 200) throw new ReadError(502, `${method} /@${handle}/${APP}/${path}: ${a.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }

  /** A read of the instance's own program past `appRead` (a route the host also answers: `/stats`). */
  private async instanceOwn(handle: string, route: string): Promise<RouterResponse> {
    const r = this.router;
    const u = new URL(`${r.origin()}/@${handle}${route}`);
    const inner = r as unknown as { forward(h: string, route: string, url: URL, req: RouterRequest): Promise<RouterResponse> };
    return await inner.forward(handle, route, u, { method: "GET", url: u.href, headers: {}, body: new Uint8Array() });
  }

  /** The validators beating on the token's topic now: identity → {peerId, minLegSats?} (the beat's body's `terms`). */
  private beating(id: string): Map<string, Validator> {
    const out = new Map<string, Validator>();
    for (const b of this.router.p2p?.live.live(id, `tm_color_${id}-live`) ?? []) {
      const identity = b.sender.toLowerCase();
      let min: unknown;
      try { min = ((this.decode(b.body) as Rec | null)?.terms as Rec | undefined)?.minLegSats; } catch { min = undefined; }
      out.set(identity, { identity, peerId: b.from, ...(typeof min === "number" || typeof min === "bigint" ? { minLegSats: min } : {}) });
    }
    return out;
  }

  /** P2: the token's live pools at or above its market's minimum commission, the market, the validators. */
  async tokenPools(id: string): Promise<TokenPools> {
    const answer = await this.instanceRead(id, "POST", "lookup", { service: `ls_amm_${id}`, query: { tokenId: id } }) as { type?: string; result?: unknown };
    if (answer?.type !== "freeform" || !Array.isArray(answer.result)) throw new ReadError(502, `ls_amm_${id} {tokenId}: not a freeform list (${JSON.stringify(answer).slice(0, 200)})`);
    const terms = await this.instanceRead(id, "GET", "terms") as { market?: Market };
    const market: Market = terms?.market && typeof terms.market === "object" ? terms.market : {};
    const min = num(market.minCommissionBps);
    const live = this.beating(id);
    const pools: PoolRow[] = [];
    for (const p of answer.result as Rec[]) {
      const v = typeof p.validatorIdentityKey === "string" ? p.validatorIdentityKey.toLowerCase() : "";
      const val = live.get(v);
      if (val === undefined) continue;
      if (Number.isFinite(min) && !(num(p.commissionBps) >= min)) continue;
      pools.push({
        poolId: String(p.poolId),
        ...(typeof p.lpPubKey === "string" ? { lpPubKey: p.lpPubKey } : {}),
        outpoint: String(p.outpoint), bsvReserve: p.bsvReserve, tokenReserve: p.tokenReserve,
        liquidityFeeBps: p.liquidityFeeBps, validationFeeBps: p.validationFeeBps, commissionBps: p.commissionBps,
        validatorIdentityKey: v, validatorPeerId: val.peerId, swaps: p.swaps,
      });
    }
    return { market, validators: [...live.values()], pools };
  }

  /** The enabled token instances (host.db), as the reconcile names them: handles of the token id's shape. */
  private tokens(): string[] {
    return this.router.o.db.list("enabled").map((r) => r.handle).filter((h) => TOKEN_ID.test(h));
  }

  /** P1: every enabled token's pools, each row with its tokenId; a token whose read fails is left out (logged). */
  async allPools(): Promise<Array<{ tokenId: string } & PoolRow>> {
    const out: Array<{ tokenId: string } & PoolRow> = [];
    for (const id of this.tokens()) {
      try { for (const p of (await this.tokenPools(id)).pools) out.push({ tokenId: id, ...p }); } catch (e) { this.say(`${id}: pools: left out of /amm/pools: ${(e as Error).message}`); }
    }
    return out;
  }

  /** The instance's own `/stats` row (it knows no beats and no market minimum). */
  private async instanceStats(id: string): Promise<Rec> {
    const a = await this.instanceOwn(id, STATS_ROUTE);
    const text = new TextDecoder().decode(a.body);
    if (a.status !== 200) throw new ReadError(502, `GET /@${id}${STATS_ROUTE}: ${a.status} ${text.slice(0, 200)}`);
    return JSON.parse(text) as Rec;
  }

  /** The mid price of the pools listed at `t` (`/pools/at`: every listed pool, whatever its validator), or null. */
  private async midAt(id: string, t: number): Promise<Price | null> {
    const rows = await this.instanceRead(id, "GET", `pools/at?t=${t}`) as Rec[];
    return priceOf((Array.isArray(rows) ? rows : []).map(poolState))?.mid ?? null;
  }

  /** A token's stats (0.14.0): the instance's row merged with the listed pools and their price (`mergeStats`). */
  async tokenStats(id: string): Promise<Rec> {
    const now = Date.now();
    const [row, answer, then1h, then24h] = await Promise.all([this.instanceStats(id), this.tokenPools(id), this.midAt(id, Math.max(0, now - HOUR_MS)), this.midAt(id, Math.max(0, now - 24 * HOUR_MS))]);
    return mergeStats(row, answer.pools, then1h, then24h);
  }

  /** The host-wide stats: each enabled token's (`ids`: those enabled tokens only, in its order). */
  async allStats(ids: string | null): Promise<unknown[]> {
    const enabled = this.tokens();
    const want = ids === null ? enabled : ids.split(",").map((x) => x.trim()).filter((x) => enabled.includes(x));
    const out: unknown[] = [];
    for (const id of want) {
      try { out.push(await this.tokenStats(id)); } catch (e) { this.say(`${id}: stats: left out of /amm/stats: ${(e as Error).message}`); }
    }
    return out;
  }

  /** `?series=market` (0.14.0): the market-price candles (`marketCandles`) over the instance's pool history. */
  private async candleAnswer(id: string, q: URLSearchParams): Promise<RouterResponse> {
    const bad = "want ?series=market&tf=1m|5m|15m|1h|4h|1d&from=<ms>&to=<ms>";
    const tf = TIMEFRAMES[q.get("tf") ?? ""];
    const int = (s: string | null) => s !== null && /^\d+$/.test(s) ? Number(s) : undefined;
    const from = int(q.get("from")), to = int(q.get("to"));
    if (tf === undefined || from === undefined || to === undefined || to < from) return problem(400, bad);
    const start = from - (from % tf);
    if (Math.ceil((to - start) / tf) > MAX_BUCKETS) return problem(400, `the window spans more than ${MAX_BUCKETS} buckets`);
    const at = from === 0 ? [] : await this.instanceRead(id, "GET", `pools/at?t=${from - 1}`) as Rec[];
    const events: Rec[] = [];
    for (let after: string | null = null; ;) {
      const page = await this.instanceRead(id, "GET", `pools/history?from=${from}&to=${to}&limit=${HISTORY_LIMIT}${after ? `&after=${after}` : ""}`) as { events?: Rec[]; next?: string | null };
      events.push(...(page.events ?? []));
      if (!page.next) break;
      after = page.next;
    }
    return jsonAnswer(200, marketCandles(Array.isArray(at) ? at : [], events, tf), { "cache-control": CACHE });
  }

  /** The host-wide positions: each enabled token's `/positions?pool=` rows, each with its tokenId. */
  async allPositions(pool: string): Promise<Array<{ tokenId: string } & Rec>> {
    const out: Array<{ tokenId: string } & Rec> = [];
    for (const id of this.tokens()) {
      try {
        const rows = await this.instanceRead(id, "GET", `positions?pool=${encodeURIComponent(pool)}`);
        if (Array.isArray(rows)) for (const r of rows as Rec[]) out.push({ tokenId: id, ...r });
      } catch (e) { this.say(`${id}: positions: left out of /amm/positions: ${(e as Error).message}`); }
    }
    return out;
  }

  /** The host-wide spends (0.14.0): per outpoint, the first enabled token whose `/spends` names a spender. */
  async allSpends(outpoints: string[]): Promise<Array<{ outpoint: string; tokenId?: string; spentBy?: string }>> {
    const out = outpoints.map((outpoint) => ({ outpoint } as { outpoint: string; tokenId?: string; spentBy?: string }));
    for (const id of this.tokens()) {
      try {
        const a = await this.instanceRead(id, "GET", `spends?outpoint=${outpoints.map(encodeURIComponent).join(",")}`);
        const rows = (Array.isArray(a) ? a : [a]) as Rec[];
        rows.forEach((s, i) => {
          const r = out[i];
          if (r && !r.spentBy && typeof s?.spentBy === "string") { r.tokenId = id; r.spentBy = s.spentBy; }
        });
      } catch (e) { this.say(`${id}: spends: left out of /amm/spends: ${(e as Error).message}`); }
    }
    return out;
  }

  /** The host stops: every open feed ends. */
  stop(): void {
    for (const end of [...this.ends]) end();
    this.ends.clear();
    this.feeds.clear();
    this.everyFeed.clear();
  }
}
