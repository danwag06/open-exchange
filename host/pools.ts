// The Open Exchange's pool reads (0.11.0, the public read API; plans: D11, D13, D16, D22), answered by
// the HOST through skein's Router option `appRead` (skein 0.2.6) — the two routes that join what only
// the host holds (the beats it keeps per topic) to a token instance's pool index:
//
//   GET /@<tokenId>/amm/pools   {market, pools: [{lpPubKey, outpoint, bsvReserve, tokenReserve,
//                                liquidityFeeBps, validationFeeBps, commissionBps, validatorIdentityKey,
//                                validatorPeerId}]}
//       the instance's pools (its lookup ls_amm_<tokenId>, query {tokenId}) whose validator is beating
//       on tm_color_<tokenId>-live now (the host's liveness table; the peer ID is the beat's `from`) AND
//       whose commissionBps is at least the instance's market minimum; `market` = the instance's own
//       answer at GET /amm/terms (`market`: {commissionPkh, minCommissionBps}). Nothing else computed.
//   GET <origin>/amm/pools      [{tokenId, …the row above}]   every enabled token instance's, one array.
//
// Both `Cache-Control: public, max-age=5`. Asked with `Accept: text/event-stream`: an event stream, the
// answer as the first event `pools`, then the answer again each time it changed (only when its JSON
// differs). What makes it look again, per token: (a) the instance's emitted `beacon` events on
// tm_color_<id>-live and ls_amm_<id>-live (the engine re-declares them on every admission or spend that
// changes the topic's view or the pool lookup's beat: Router.events, as GET /amm/.events streams them);
// (b) a timer (POLL_MS) — the beats the host keeps arrive and expire without any event, and the market
// minimum is a head no event names; (c) for /amm/pools, a token enabled or disabled (the host's own
// reactions, `tokensChanged`). One watch per token whatever the number of streams; a watch with no
// stream left stops.
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
export interface TokenPools { market: Market; pools: PoolRow[] }

const enc = (s: string) => new TextEncoder().encode(s);
const jsonAnswer = (status: number, v: unknown, headers: Record<string, string> = {}): RouterResponse =>
  ({ status, headers: { "content-type": "application/json", ...headers }, body: enc(JSON.stringify(v)) });
const problem = (status: number, description: string) => jsonAnswer(status, { status: "error", code: status === 404 ? "ERR_NOT_FOUND" : "ERR_UNAVAILABLE", description });
const sse = (json: string) => `event: pools\ndata: ${json}\n\n`;
const num = (v: unknown) => typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;

class ReadError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** What changes reach a stream: a JSON answer, or the end (the instance stopped). */
interface Client { send(json: string): void; end(): void }

/** One token's answer, watched for as long as a stream holds it. */
class Watch {
  readonly clients = new Set<Client>();
  last?: string;
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
        let json: string;
        try { json = JSON.stringify(await this.pools.tokenPools(this.id)); } catch (e) { this.pools.say(`${this.id}: pools: ${(e as Error).message}`); continue; }
        if (this.stopped || json === this.last) continue;
        this.last = json;
        for (const c of this.clients) c.send(json);
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
  /** The host-wide streams (GET /amm/pools as an event stream): told when the enabled tokens change. */
  private readonly all = new Set<() => void>();

  readonly router: Router;
  readonly say: (line: string) => void;
  constructor(router: Router, say: (line: string) => void) { this.router = router; this.say = say; }

  /** RouterOptions.appRead: P2 at a token instance, P1 at swap; anything else undefined (forwarded). */
  async appRead(handle: string, route: string, _url: URL, req: RouterRequest): Promise<RouterResponse | undefined> {
    if (route !== POOLS_ROUTE) return undefined;
    const stream = /text\/event-stream/.test(req.headers.accept ?? "");
    if (TOKEN_ID.test(handle)) return stream ? this.tokenStream(handle) : await this.tokenAnswer(handle);
    if (handle === SWAP) return stream ? this.allStream() : jsonAnswer(200, await this.allPools(), { "cache-control": CACHE });
    return undefined;
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
    return { market, pools };
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

  // ---------------------------------------------------------------- the streams

  private watch(id: string): Watch {
    let w = this.watches.get(id);
    if (!w) { const nw: Watch = new Watch(this, id, () => { if (this.watches.get(id) === nw) this.watches.delete(id); }); this.watches.set(id, nw); w = nw; }
    return w;
  }

  private static held(open: (send: (c: string) => void, end: () => void) => () => void): RouterResponse {
    return { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }, body: new Uint8Array(), stream: open };
  }

  /** P2 as an event stream. */
  private tokenStream(id: string): RouterResponse {
    return Pools.held((send, end) => {
      const w = this.watch(id);
      const c: Client = { send: (j) => send(sse(j)), end };
      w.clients.add(c);
      if (w.last !== undefined) c.send(w.last);
      return () => { w.clients.delete(c); if (!w.clients.size) w.stop(); };
    });
  }

  /** P1 as an event stream: one watch per enabled token; the array sent again when any of them changed or the tokens did. */
  private allStream(): RouterResponse {
    return Pools.held((send) => {
      const held = new Map<string, { w: Watch; c: Client }>();
      let last: string | undefined;
      let done = false;
      const combine = () => {
        if (done) return;
        const rows: unknown[] = [];
        for (const id of this.tokens()) {
          const j = held.get(id)?.w.last;
          if (j) for (const p of (JSON.parse(j) as TokenPools).pools) rows.push({ tokenId: id, ...p });
        }
        const json = JSON.stringify(rows);
        if (json !== last) { last = json; send(sse(json)); }
      };
      const sync = () => {
        if (done) return;
        const want = new Set(this.tokens());
        for (const [id, h] of held) if (!want.has(id)) { held.delete(id); h.w.clients.delete(h.c); if (!h.w.clients.size) h.w.stop(); }
        const waits: Promise<void>[] = [];
        for (const id of want) {
          if (held.has(id)) continue;
          const w = this.watch(id);
          const c: Client = { send: () => combine(), end: () => { held.delete(id); combine(); } };
          w.clients.add(c);
          held.set(id, { w, c });
          waits.push(w.ready);
        }
        // The first event: once every token's first read is in.
        void Promise.all(waits).then(combine);
      };
      this.all.add(sync);
      sync();
      return () => {
        done = true;
        this.all.delete(sync);
        for (const { w, c } of held.values()) { w.clients.delete(c); if (!w.clients.size) w.stop(); }
        held.clear();
      };
    });
  }

  /** A token enabled or disabled (the host's reactions): the host-wide streams follow. */
  tokensChanged(): void { for (const f of [...this.all]) f(); }

  /** The host stops: every watch ends. */
  stop(): void { for (const w of [...this.watches.values()]) w.stop(); }
}
