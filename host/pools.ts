// The Open Exchange's pool reads (0.11.0, the public read API; plans: D11, D13, D16, D22), answered by
// the HOST through skein's Router option `appRead` (skein 0.2.6) — the two routes that join what only
// the host holds (the beats it keeps per topic) to a token instance's pool index:
//
//   GET /@<tokenId>/amm/pools   {market, validators: [{identity, peerId}], pools: [{lpPubKey, outpoint,
//                                bsvReserve, tokenReserve, liquidityFeeBps, validationFeeBps, commissionBps,
//                                validatorIdentityKey, validatorPeerId}]}
//       the instance's pools (its lookup ls_amm_<tokenId>, query {tokenId}) whose validator is beating
//       on tm_color_<tokenId>-live now (the host's liveness table; the peer ID is the beat's `from`) AND
//       whose commissionBps is at least the instance's market minimum; `market` = the instance's own
//       answer at GET /amm/terms (`market`: {commissionPkh, minCommissionBps}); `validators` = every
//       validator beating on tm_color_<tokenId>-live now (identity hex, peer ID the beat's `from`), whatever
//       its pools (0.11.0, David: the Positions page shows a validator live when its pool is below the
//       market minimum). Nothing else computed.
//   GET <origin>/amm/pools      [{tokenId, …the row above}]   every enabled token instance's, one array.
//                                (0.13.0, D7: a plain read only — the host-wide event stream is gone.)
//   GET <origin>/amm/stats      (0.13.0, D3) [<a token's GET /@<id>/amm/stats>]   every enabled token's,
//                                one array; `?ids=a,b` those enabled tokens only, in the query's order.
//   GET <origin>/amm/positions?lp=k1,k2   (0.13.0, D6) [{tokenId, …a row of GET /@<id>/amm/positions?lp=}]
//                                every enabled token's rows for the keys (an unknown key: `closed`, zeros).
//
// All `Cache-Control: public, max-age=5`; a token whose read fails is left out (logged). The token's pools
// route asked with `Accept: text/event-stream` (0.13.0, D7): an event stream, the whole answer as the first
// event `pools` (a page starts from it), then ONE event `change` per pool change, `{kind: "deploy" |
// "swap" | "close" | "rescind", outpoint, pool?, trade?}` — the host diffs the previous and the new answer
// per look: a new outpoint whose transaction has a trade row (`GET /@<id>/amm/trades?txid=`) is a `swap`
// (`pool` the new row, `trade` that row); a new outpoint without one a `deploy` (`pool`); an outpoint gone
// with no successor (no new row of its LP key) a `rescind` when the instance's `/positions?lp=` says the
// LP key's pool is `rescinded` (the lookup delists a rescinded pool, so the row vanishes), else a `close`.
// A change of `market` or `validators` (not a pool change) sends the whole answer again as `pools`, and so
// does a look whose changes cannot be read. What makes it look again: (a) the instance's emitted `beacon`
// events on tm_color_<id>-live and ls_amm_<id>-live (the engine re-declares them on every admission or
// spend that changes the topic's view or the pool lookup's beat: Router.events, as GET /amm/.events streams
// them); (b) a timer (POLL_MS) — the beats the host keeps arrive and expire without any event, and the
// market minimum is a head no event names. One watch per token whatever the number of streams; a watch
// with no stream left stops.
import { SWAP } from "./exchange.ts";
import type { Router } from "./skein.ts";

type RouterRequest = import("@dcasegr/skein/dist/host/router.js").RouterRequest;
type RouterResponse = import("@dcasegr/skein/dist/host/router.js").RouterResponse;
type Rec = Record<string, unknown>;

const TOKEN_ID = /^[0-9a-f]{64}_\d+$/;
/** The token app's name (its routes are /amm/…, its events' `app`). */
const APP = "amm";
/** The route both reads answer at (the token instance's, the swap instance's). */
export const POOLS_ROUTE = `/${APP}/pools`;
/** The host-wide joins at swap (0.13.0): every enabled token's stats, every enabled token's positions. */
export const STATS_ROUTE = `/${APP}/stats`;
export const POSITIONS_ROUTE = `/${APP}/positions`;
/** How often a watched answer is read again with no event (ms): beats arrive every 120 s and expire past a 300 s window (builder's call, David to review). */
export const POLL_MS = 15_000;
const CACHE = "public, max-age=5";

/** One pool as the routes answer it. */
export interface PoolRow {
  lpPubKey?: string; outpoint: string; bsvReserve: unknown; tokenReserve: unknown;
  liquidityFeeBps: unknown; validationFeeBps: unknown; commissionBps: unknown;
  validatorIdentityKey: string; validatorPeerId: string;
}
export interface Market { commissionPkh?: unknown; minCommissionBps?: unknown }
export interface Validator { identity: string; peerId: string }
export interface TokenPools { market: Market; validators: Validator[]; pools: PoolRow[] }
/** One pool change on the token's stream (0.13.0, D7). */
export interface Change { kind: "deploy" | "swap" | "close" | "rescind"; outpoint: string; pool?: PoolRow; trade?: unknown }

const enc = (s: string) => new TextEncoder().encode(s);
const jsonAnswer = (status: number, v: unknown, headers: Record<string, string> = {}): RouterResponse =>
  ({ status, headers: { "content-type": "application/json", ...headers }, body: enc(JSON.stringify(v)) });
const problem = (status: number, description: string) => jsonAnswer(status, { status: "error", code: status === 404 ? "ERR_NOT_FOUND" : "ERR_UNAVAILABLE", description });
const sse = (event: string, json: string) => `event: ${event}\ndata: ${json}\n\n`;
/** The validators in a stable order (the beat table's order is its own). */
const sameMeta = (x: TokenPools, y: TokenPools) => JSON.stringify(x.market) === JSON.stringify(y.market) &&
  JSON.stringify([...x.validators].sort((a, b) => a.identity.localeCompare(b.identity))) === JSON.stringify([...y.validators].sort((a, b) => a.identity.localeCompare(b.identity)));
const num = (v: unknown) => typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;

class ReadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** What reaches a stream: an event (`pools` the whole answer, `change` one pool change), or the end (the instance stopped). */
interface Client { send(event: string, json: string): void; end(): void }

/** One token's answer, watched for as long as a stream holds it. */
class Watch {
  readonly clients = new Set<Client>();
  /** The last answer (its JSON, what a stream joining now starts from). */
  last?: string;
  private lastAnswer?: TokenPools;
  private forget?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private again = false;
  private stopped = false;
  ready: Promise<void>;
  private readonly pools: Pools;
  readonly id: string;
  private readonly gone: () => void;

  constructor(pools: Pools, id: string, gone: () => void) {
    this.pools = pools; this.id = id; this.gone = gone;
    this.ready = this.start();
  }

  private async start(): Promise<void> {
    const r = this.pools.router;
    const q = { app: APP, event: "beacon", topics: [`tm_color_${this.id}-live`, `ls_amm_${this.id}-live`] };
    try {
      const forget = await r.events.subscribe(this.id, q, () => this.look(), () => this.end());
      if (this.stopped) forget(); else this.forget = forget;
    } catch (e) { this.pools.say(`${this.id}: pools stream: its events not followed: ${(e as Error).message}`); }
    if (this.stopped) return;
    this.timer = setInterval(() => this.look(), POLL_MS);
    this.timer.unref?.();
    await this.read();
  }

  /** Read again (coalesced: one read at a time, one more after it when asked meanwhile). */
  look(): void {
    if (this.stopped) return;
    if (this.running) { this.again = true; return; }
    void this.read();
  }

  private async read(): Promise<void> {
    this.running = true;
    try {
      do {
        this.again = false;
        let answer: TokenPools;
        try { answer = await this.pools.tokenPools(this.id); } catch (e) { this.pools.say(`${this.id}: pools: ${(e as Error).message}`); continue; }
        const json = JSON.stringify(answer);
        if (this.stopped || json === this.last) continue;
        const prev = this.lastAnswer;
        // Not a pool change (the first look, the market, the validators): the whole answer again.
        let changes: Change[] | undefined;
        if (prev && sameMeta(prev, answer)) {
          try { changes = await this.pools.changes(this.id, prev.pools, answer.pools); } catch (e) { this.pools.say(`${this.id}: pools: the changes not read (the whole answer sent): ${(e as Error).message}`); }
        }
        if (this.stopped) continue;
        // Kept only now: a stream that joined while the changes were read starts from the previous
        // answer and gets them.
        this.last = json;
        this.lastAnswer = answer;
        if (changes) { for (const ch of changes) { const j = JSON.stringify(ch); for (const c of this.clients) c.send("change", j); } }
        else for (const c of this.clients) c.send("pools", json);
      } while (this.again && !this.stopped);
    } finally { this.running = false; }
  }

  /** The instance stopped (its subscriptions closed): every stream on it ends. */
  private end(): void {
    const cs = [...this.clients];
    this.stop();
    for (const c of cs) c.end();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clients.clear();
    if (this.timer) clearInterval(this.timer);
    this.forget?.();
    this.gone();
  }
}

export class Pools {
  private readonly watches = new Map<string, Watch>();
  readonly router: Router;
  readonly say: (line: string) => void;
  constructor(router: Router, say: (line: string) => void) { this.router = router; this.say = say; }

  /** RouterOptions.appRead: P2 at a token instance; P1, the stats and the positions joins at swap; anything else undefined (forwarded). */
  async appRead(handle: string, route: string, url: URL, req: RouterRequest): Promise<RouterResponse | undefined> {
    if (handle === SWAP) {
      if (route === POOLS_ROUTE) return jsonAnswer(200, await this.allPools(), { "cache-control": CACHE });
      if (route === STATS_ROUTE) return jsonAnswer(200, await this.allStats(url.searchParams.get("ids")), { "cache-control": CACHE });
      if (route === POSITIONS_ROUTE) {
        const lp = url.searchParams.get("lp");
        if (!lp) return jsonAnswer(400, { status: "error", code: "ERR_BAD_REQUEST", description: "want ?lp=k1,k2" });
        return jsonAnswer(200, await this.allPositions(lp), { "cache-control": CACHE });
      }
      return undefined;
    }
    if (route !== POOLS_ROUTE || !TOKEN_ID.test(handle)) return undefined;
    const stream = /text\/event-stream/.test(req.headers.accept ?? "");
    return stream ? this.tokenStream(handle) : await this.tokenAnswer(handle);
  }

  // ---------------------------------------------------------------- the answers

  /** An in-process GET of the instance's own (`/@<handle>/amm/<path>`). */
  private async instanceRead(handle: string, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const r = this.router;
    const a = await r.dispatch({ method, url: `${r.origin()}/@${handle}/${APP}/${path}`, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? new Uint8Array() : enc(JSON.stringify(body)) });
    const text = new TextDecoder().decode(a.body);
    if (a.status !== 200) throw new ReadError(502, `${method} /@${handle}/${APP}/${path}: ${a.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }

  /** An in-process GET of the instance's own (`/@<handle>/amm/<path>`): its status and JSON. */
  private async instanceGet(handle: string, path: string): Promise<{ status: number; json?: unknown }> {
    const r = this.router;
    const a = await r.dispatch({ method: "GET", url: `${r.origin()}/@${handle}/${APP}/${path}`, headers: {}, body: new Uint8Array() });
    const text = new TextDecoder().decode(a.body);
    if (a.status !== 200) return { status: a.status };
    return { status: 200, json: JSON.parse(text) };
  }

  /** A Swap's trade row on the token (`/trades?txid=`), or undefined when the transaction has none (404). */
  private async tradeOf(id: string, txid: string): Promise<unknown> {
    const a = await this.instanceGet(id, `trades?txid=${txid}`);
    if (a.status === 404) return undefined;
    if (a.status !== 200) throw new ReadError(502, `GET /@${id}/${APP}/trades?txid=${txid}: ${a.status}`);
    return a.json;
  }

  /** An LP key's position status on the token (`/positions?lp=`). */
  private async statusOf(id: string, lp: string): Promise<string | undefined> {
    const rows = await this.instanceRead(id, "GET", `positions?lp=${lp}`) as Array<{ status?: string }>;
    return Array.isArray(rows) ? rows[0]?.status : undefined;
  }

  /** The pool changes between two answers' pools (the stream's `change` events, D7). */
  async changes(id: string, prev: PoolRow[], next: PoolRow[]): Promise<Change[]> {
    const before = new Set(prev.map((p) => p.outpoint));
    const after = new Set(next.map((p) => p.outpoint));
    const out: Change[] = [];
    const continued = new Set<string>();
    for (const p of next) {
      if (before.has(p.outpoint)) continue;
      if (p.lpPubKey) continued.add(p.lpPubKey);
      const trade = await this.tradeOf(id, p.outpoint.split("_")[0]!);
      out.push(trade === undefined ? { kind: "deploy", outpoint: p.outpoint, pool: p } : { kind: "swap", outpoint: p.outpoint, pool: p, trade });
    }
    for (const p of prev) {
      if (after.has(p.outpoint)) continue;
      // Its successor (a Swap's continuation keeps the LP key, the pool's id) came in above.
      if (p.lpPubKey && continued.has(p.lpPubKey)) continue;
      const status = p.lpPubKey ? await this.statusOf(id, p.lpPubKey) : undefined;
      out.push({ kind: status === "rescinded" ? "rescind" : "close", outpoint: p.outpoint });
    }
    return out;
  }

  /** P2: the token's live pools at or above its market's minimum commission, and the market. */
  async tokenPools(id: string): Promise<TokenPools> {
    const answer = await this.instanceRead(id, "POST", "lookup", { service: `ls_amm_${id}`, query: { tokenId: id } }) as { type?: string; result?: unknown };
    if (answer?.type !== "freeform" || !Array.isArray(answer.result)) throw new ReadError(502, `ls_amm_${id} {tokenId}: not a freeform list (${JSON.stringify(answer).slice(0, 200)})`);
    const terms = await this.instanceRead(id, "GET", "terms") as { market?: Market };
    const market: Market = terms?.market && typeof terms.market === "object" ? terms.market : {};
    const min = num(market.minCommissionBps);
    const live = new Map<string, string>();
    for (const b of this.router.p2p?.live.live(id, `tm_color_${id}-live`) ?? []) live.set(b.sender.toLowerCase(), b.from);
    const pools: PoolRow[] = [];
    for (const p of answer.result as Rec[]) {
      const v = typeof p.validatorIdentityKey === "string" ? p.validatorIdentityKey.toLowerCase() : "";
      const peer = live.get(v);
      if (peer === undefined) continue;
      if (Number.isFinite(min) && !(num(p.commissionBps) >= min)) continue;
      pools.push({
        ...(typeof p.lpPubKey === "string" ? { lpPubKey: p.lpPubKey } : {}),
        outpoint: String(p.outpoint), bsvReserve: p.bsvReserve, tokenReserve: p.tokenReserve,
        liquidityFeeBps: p.liquidityFeeBps, validationFeeBps: p.validationFeeBps, commissionBps: p.commissionBps,
        validatorIdentityKey: v, validatorPeerId: peer,
      });
    }
    const validators: Validator[] = [...live].map(([identity, peerId]) => ({ identity, peerId }));
    return { market, validators, pools };
  }

  private async tokenAnswer(id: string): Promise<RouterResponse> {
    try { return jsonAnswer(200, await this.tokenPools(id), { "cache-control": CACHE }); } catch (e) {
      return problem(e instanceof ReadError ? e.status : 503, (e as Error).message);
    }
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

  /** The host-wide stats (0.13.0, D3): each enabled token's `/stats` (`ids`: those enabled tokens only, in its order). */
  async allStats(ids: string | null): Promise<unknown[]> {
    const enabled = this.tokens();
    const want = ids === null ? enabled : ids.split(",").map((x) => x.trim()).filter((x) => enabled.includes(x));
    const out: unknown[] = [];
    for (const id of want) {
      try { out.push(await this.instanceRead(id, "GET", "stats")); } catch (e) { this.say(`${id}: stats: left out of /amm/stats: ${(e as Error).message}`); }
    }
    return out;
  }

  /** The host-wide positions (0.13.0, D6): each enabled token's `/positions?lp=` rows, each with its tokenId. */
  async allPositions(lp: string): Promise<Array<{ tokenId: string } & Rec>> {
    const out: Array<{ tokenId: string } & Rec> = [];
    for (const id of this.tokens()) {
      try {
        const rows = await this.instanceRead(id, "GET", `positions?lp=${encodeURIComponent(lp)}`);
        if (Array.isArray(rows)) for (const r of rows as Rec[]) out.push({ tokenId: id, ...r });
      } catch (e) { this.say(`${id}: positions: left out of /amm/positions: ${(e as Error).message}`); }
    }
    return out;
  }

  // ---------------------------------------------------------------- the stream

  private watch(id: string): Watch {
    let w = this.watches.get(id);
    if (!w) { const nw: Watch = new Watch(this, id, () => { if (this.watches.get(id) === nw) this.watches.delete(id); }); this.watches.set(id, nw); w = nw; }
    return w;
  }

  private static held(open: (send: (c: string) => void, end: () => void) => () => void): RouterResponse {
    return { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }, body: new Uint8Array(), stream: open };
  }

  /** P2 as an event stream: the whole answer first (`pools`), then one `change` per pool change. */
  private tokenStream(id: string): RouterResponse {
    return Pools.held((send, end) => {
      const w = this.watch(id);
      const c: Client = { send: (ev, j) => send(sse(ev, j)), end };
      w.clients.add(c);
      if (w.last !== undefined) c.send("pools", w.last);
      return () => { w.clients.delete(c); if (!w.clients.size) w.stop(); };
    });
  }

  /** The host stops: every watch ends. */
  stop(): void { for (const w of [...this.watches.values()]) w.stop(); }
}
