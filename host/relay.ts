// The swap relay (open-exchange 0.17.0, skein-amm 0.44.0; David Case 2026-11-06: "the instance logs FACTS, never
// ATTEMPTS"). The HOST is the relay: a swap being forwarded is an attempt, so nothing of it is logged on the taker's
// side; the only entry there is the overlay submission of the transaction the validator returned.
//
//   POST /@<tokenId>/amm/swap      a plain route (no BRC-104 session, as /submit is plain)
//   body    {funding, swap, pool, validator, peerId}      JSON; bytes as DAG-JSON bytes ({"/": {"bytes": <base64>}})
//             funding    the taker's funding transaction, the wallet's Atomic BEEF (its ancestry with it)
//             swap       the raw swap, the validator's signature slot OP_0
//             pool       the pool outpoint it spends, <txid>_<vout>
//             validator  the pool's ValidatorIdentity, 33 bytes
//             peerId     the validator's libp2p peer ID (the pools route's validatorPeerId)
//   answer  200 the validator's reply as it is (DAG-JSON):   {ok: true, tx, txid, beef?}
//                                                            {ok: false, reason, detail?, pool?, beef?}
//           200 the host's own:  {ok: false, reason: "commission_missing", detail}   the one rule it checks (nothing relayed)
//                                {ok: false, reason: "unreachable", detail}          any break in the call, named
//           400 / 404 / 503 {status: "error", code, description}   a body that is not the shape, no such token here,
//                                the commission key not to be had (nothing relayed)
//
// The steps, in order, nothing written anywhere until the last:
//   1. the commission rule (skein-amm programs/amm-p2p/README.md "The commission rule"; amm-p2p 0.43.0 `checkPair`'s
//      `commission_missing`): input 0's unlocking script a Rúnar Swap call (13 pushes, the method 0), output 0 the
//      pool's continuation; its CommissionBps > 0 → the call's commissionPkh (push 6) must be hash160 of the token
//      instance's own key for [1, "amm commission"], key ID "relay", counterparty anyone, forSelf. Nothing else is
//      checked: everything else is the validator's.
//   2. the validator's package (amm-validator README "A direct call"): {message, body, topic} — the mail record signed
//      BRC-169's way by the token instance's key through the host's key holder, outside any step (Router.signMessage),
//      recipient the validator, box "swap", nonce the first 16 bytes of sha256("amm-swap-relay" ‖ sha256(swap)); the
//      body {tx: <one BEEF: the funding's ancestry and every swap input's source the funding BEEF holds, the swap
//      last>, pool}; topic the token's tm_color_<tokenId> (the validator's host picks the instance by it).
//   3. carried: to a peer, P2PHost.call on /amm-validator/1/swap (one stream: one request frame, one answer frame);
//      when peerId is this host's own node, handed in as that node's inbound frame (Router.p2pInbound), as any other
//      peer's frame would be.
//   4. a reply carrying `beef` (an accepted swap's, a pool_spent refusal's newest state) from ANOTHER node: submitted
//      to the token instance's overlay (in process, POST /submit with the token topic) and its answer awaited before
//      the page is answered, so the page's next pools read reflects it. (The local validator's submission is this
//      overlay's already.)
//   5. the page answered.
//
// THE PAGE'S CONNECTION IS THE ONLY TIMER: the attempt lives exactly as long as the page's request. When the request
// closes, `signal` fires and the host stops — a dial in progress cancelled, a request not yet written never written,
// an open stream closed. Once written it is delivered: the validator answers on its stream; a signed swap lands on the
// overlay and the page's settle pass finds it. No retries, no re-offer, no host timers, nothing resumes after a restart.
import { Beef, Hash, Transaction, Utils } from "@bsv/sdk";
import { PARAM_ASSET_ID, PARAM_COMMISSION_BPS, PARAM_LP_FEE_BPS, PARAM_VALIDATOR_FEE_BPS, POOL_SLOTS, POOL_TEMPLATE_HEX } from "./pool-code.ts";
import type { Router, Skein } from "./skein.ts";

type RouterRequest = import("@dcasegr/skein/dist/host/router.js").RouterRequest;
type RouterResponse = import("@dcasegr/skein/dist/host/router.js").RouterResponse;
type Rec = Record<string, unknown>;

const TOKEN_ID = /^[0-9a-f]{64}_\d+$/;
const OUTPOINT = /^[0-9a-f]{64}_(0|[1-9]\d{0,9})$/;
/** The host's swap route, at the token instance (`/@<tokenId>/amm/swap`). */
export const SWAP_ROUTE = "/amm/swap";
/** The validator's direct call (amm-validator's libp2p row). */
export const SWAP_PROTOCOL = "/amm-validator/1/swap";
/** The commission key (skein-amm amm-p2p interface.zig `commission_protocol`, `commission_key_id`). */
export const COMMISSION_PROTOCOL: [1, string] = [1, "amm commission"];
export const COMMISSION_KEY_ID = "relay";
/** A Swap call's pushes (src/pool.zig `swap_pushes`): `_codePart, validatorSig, nextValidatorPubKey, amountIn, bsvIn,
 *  userPkh, commissionPkh, tokenChangePkh, tokenChange, _changePKH, _changeAmount, txPreimage, methodIndex`. */
const SWAP_PUSHES = 13;

const enc = (s: string) => new TextEncoder().encode(s);
const answer = (status: number, v: unknown): RouterResponse => ({ status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: enc(toDagJson(v)) });
const problem = (status: number, code: string, description: string) => answer(status, { status: "error", code, description });
const hex = (b: Uint8Array | number[]) => Buffer.from(b).toString("hex");

/** A value as DAG-JSON: bytes `{"/": {"bytes": <base64, unpadded>}}`, a CID `{"/": <text>}`, a bigint a JSON number. */
export function toDagJson(v: unknown): string {
  const walk = (x: unknown): unknown => {
    if (x instanceof Uint8Array) return { "/": { bytes: Buffer.from(x).toString("base64").replace(/=+$/, "") } };
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      const c = x as { asCID?: unknown; toString(): string };
      if (c.asCID === x) return { "/": c.toString() };
      return Object.fromEntries(Object.entries(x as Rec).map(([k, y]) => [k, walk(y)]));
    }
    return x;
  };
  return JSON.stringify(walk(v), (_k, x) => typeof x === "bigint" ? (JSON as unknown as { rawJSON(t: string): unknown }).rawJSON(x.toString()) : x);
}

/** DAG-JSON bytes → bytes, or undefined. */
function dagBytes(x: unknown): Uint8Array | undefined {
  const b = (x as { "/"?: { bytes?: unknown } } | null)?.["/"]?.bytes;
  if (typeof b !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(b)) return undefined;
  return new Uint8Array(Buffer.from(b, "base64"));
}

// ---------------------------------------------------------------- script reading (skein-1color brc162, skein-amm src/pool.zig)

interface Push { op: number; data: Uint8Array; next: number }
function readPush(s: Uint8Array, pos: number): Push | null {
  if (pos >= s.length) return null;
  const op = s[pos]!;
  let at = pos + 1;
  let len: number;
  if (op === 0x00) len = 0;
  else if (op >= 0x01 && op <= 0x4b) len = op;
  else if (op === 0x4c) { if (at + 1 > s.length) return null; len = s[at]!; at += 1; }
  else if (op === 0x4d) { if (at + 2 > s.length) return null; len = s[at]! | (s[at + 1]! << 8); at += 2; }
  else if (op === 0x4e) { if (at + 4 > s.length) return null; len = (s[at]! | (s[at + 1]! << 8) | (s[at + 2]! << 16)) + s[at + 3]! * 0x1000000; at += 4; }
  else if (op === 0x4f || (op >= 0x51 && op <= 0x60)) return { op, data: new Uint8Array(), next: at };
  else return null;
  if (len > s.length - at) return null;
  return { op, data: s.subarray(at, at + len), next: at + len };
}
/** A minimal script number (src/pool.zig `canonicalNum`), or null. */
function canonicalNum(p: Push): bigint | null {
  if (p.op === 0x00) return 0n;
  if (p.op === 0x4f) return -1n;
  if (p.op >= 0x51 && p.op <= 0x60) return BigInt(p.op - 0x50);
  if (p.op < 0x01 || p.op > 0x08) return null;
  const b = p.data;
  const last = b[b.length - 1]!;
  if ((last & 0x7f) === 0 && (b.length === 1 || (b[b.length - 2]! & 0x80) === 0)) return null;
  let mag = 0n;
  for (let i = 0; i < b.length; i++) mag |= BigInt(i === b.length - 1 ? b[i]! & 0x7f : b[i]!) << BigInt(8 * i);
  const neg = (last & 0x80) !== 0;
  if ((!neg && mag >= 1n && mag <= 16n) || (neg && mag === 1n)) return null;
  return neg ? -mag : mag;
}
/** A non-negative script number, minimal or not (src/pool.zig `numOf`), or null. */
function numOf(p: Push): bigint | null {
  if (p.op === 0x00) return 0n;
  if (p.op >= 0x51 && p.op <= 0x60) return BigInt(p.op - 0x50);
  if (p.op < 0x01 || p.op > 0x09) return null;
  const b = p.data;
  if ((b[b.length - 1]! & 0x80) !== 0) return null;
  if (b.length > 8 && b[8] !== 0) return null;
  let v = 0n;
  for (let i = 0; i < Math.min(b.length, 8); i++) v |= BigInt(b[i]!) << BigInt(8 * i);
  return v;
}

/** The Swap call input 0's unlocking script carries (src/pool.zig `methodOf` 0 + `parseSwapCall`), or null. */
export function swapCallOf(script: Uint8Array): { amountIn: bigint; commissionPkh: Uint8Array } | null {
  const pushes: Push[] = [];
  for (let pos = 0; pos < script.length; ) {
    const p = readPush(script, pos);
    if (!p) return null;
    pushes.push(p);
    pos = p.next;
  }
  if (pushes.length !== SWAP_PUSHES || canonicalNum(pushes[SWAP_PUSHES - 1]!) !== 0n) return null;
  const amountIn = numOf(pushes[3]!);
  if (amountIn === null || pushes[6]!.data.length !== 20) return null;
  return { amountIn, commissionPkh: pushes[6]!.data };
}

const TEMPLATE = new Uint8Array(Buffer.from(POOL_TEMPLATE_HEX, "hex"));

/** A pool output's fee rates: its 1Color value prefix, then the Pool code with the constructor args at the slots
 *  (src/pool.zig `parse`, the code part; brc162 `decode`'s value role); null when it is not one. */
export function poolFeesOf(script: Uint8Array): { lpFeeBps: bigint; validatorFeeBps: bigint; commissionBps: bigint } | null {
  // <push id (32 bytes)> <push amount> OP_2DROP [<payload> OP_DROP] <lock>
  const id = readPush(script, 0);
  if (!id || id.op !== 0x20) return null;
  const amt = readPush(script, id.next);
  if (!amt) return null;
  let pos = amt.next;
  if (script[pos] !== 0x6d) return null;
  pos += 1;
  const pl = readPush(script, pos);
  if (pl && script[pl.next] === 0x75) pos = pl.next + 1;
  const lock = script.subarray(pos);
  const fees = new Map<number, bigint>();
  let tpos = 0, at = 0;
  for (const s of POOL_SLOTS) {
    const seg = TEMPLATE.subarray(tpos, s.offset);
    if (lock.length - at < seg.length || Buffer.compare(lock.subarray(at, at + seg.length), seg) !== 0) return null;
    at += seg.length;
    tpos = s.offset + 1;
    const p = readPush(lock, at);
    if (!p) return null;
    at = p.next;
    if (s.param === PARAM_ASSET_ID) { if (p.op !== 0x20) return null; continue; }
    if (s.param !== PARAM_LP_FEE_BPS && s.param !== PARAM_VALIDATOR_FEE_BPS && s.param !== PARAM_COMMISSION_BPS) return null;
    const v = canonicalNum(p);
    if (v === null || (fees.has(s.param) && fees.get(s.param) !== v)) return null;
    fees.set(s.param, v);
  }
  const tail = TEMPLATE.subarray(tpos);
  if (lock.length - at < tail.length || Buffer.compare(lock.subarray(at, at + tail.length), tail) !== 0) return null;
  const lp = fees.get(PARAM_LP_FEE_BPS), val = fees.get(PARAM_VALIDATOR_FEE_BPS), com = fees.get(PARAM_COMMISSION_BPS);
  return lp === undefined || val === undefined || com === undefined ? null : { lpFeeBps: lp, validatorFeeBps: val, commissionBps: com };
}

/** The contract's fee (src/pool.zig `feeOf`): ⌈amount · bps / 10 000⌉. */
const feeOf = (amount: bigint, bps: bigint) => (amount * bps + 9999n) / 10000n;

/**
 * The commission rule (skein-amm programs/amm-p2p/README.md "The commission rule"): null when the swap may be
 * relayed; else the refusal `{reason, detail}`.
 */
export function commissionRule(swap: Transaction, ours: Uint8Array): { reason: string; detail: string } | null {
  const unlock = swap.inputs[0]?.unlockingScript?.toBinary();
  const call = unlock ? swapCallOf(Uint8Array.from(unlock)) : null;
  if (!call) return { reason: "commission_missing", detail: "input 0 is not a Rúnar call of the pool's Swap: the commission cannot be shown" };
  const cont = swap.outputs[0] ? poolFeesOf(Uint8Array.from(swap.outputs[0].lockingScript.toBinary())) : null;
  if (!cont) return { reason: "commission_missing", detail: "output 0 is not the pool's continuation: the commission cannot be shown" };
  if (cont.commissionBps < 0n) return { reason: "commission_missing", detail: "commissionBps is negative" };
  if (feeOf(call.amountIn, cont.commissionBps) > 0n && Buffer.compare(Buffer.from(call.commissionPkh), Buffer.from(ours)) !== 0)
    return { reason: "commission_missing", detail: `the commission pays ${hex(call.commissionPkh)}, not ${hex(ours)}` };
  return null;
}

// ---------------------------------------------------------------- the request BEEF (amm-p2p 0.43.0 relay.zig `requestBeef`)

/**
 * The one BEEF the validator gets: the ancestry (in the funding BEEF) of the funding transaction and of every swap
 * input whose source that BEEF holds, the swap last as the subject; V2, parents first. A funding given raw: that
 * transaction and the swap.
 */
export function requestBeef(funding: Uint8Array, swap: Transaction): { beef: number[]; fundingTxid: string } {
  const magic = funding.length >= 4 ? Buffer.from(funding.subarray(0, 4)).readUInt32LE(0) : 0;
  const isBeef = magic === 0xefbe0001 || magic === 0xefbe0002 || magic === 0x01010101; // BEEF V1, V2, Atomic (BRC-62, BRC-96, BRC-95)
  if (!isBeef) {
    const ft = Transaction.fromBinary(Array.from(funding));
    const b = new Beef();
    b.mergeRawTx(ft.toBinary());
    b.mergeRawTx(swap.toBinary());
    return { beef: b.toBinary(), fundingTxid: ft.id("hex") };
  }
  const b = Beef.fromBinary(Array.from(funding));
  const fundingTxid = b.atomicTxid ?? b.txs[b.txs.length - 1]?.txid;
  if (!fundingTxid || !b.findTxid(fundingTxid)) throw new Error("funding: a BEEF whose subject is no transaction it holds");
  b.atomicTxid = undefined;
  const keep = new Set<string>();
  const walk = (txid: string) => {
    if (keep.has(txid)) return;
    const e = b.findTxid(txid);
    if (!e) return;
    keep.add(txid);
    if (e.isTxidOnly || e.bumpIndex !== undefined || !e.tx) return; // proven, or txid only: no further ancestry needed
    for (const i of e.tx.inputs) if (i.sourceTXID) walk(i.sourceTXID);
  };
  walk(fundingTxid);
  for (const i of swap.inputs) if (i.sourceTXID && b.findTxid(i.sourceTXID)) walk(i.sourceTXID);
  for (const t of [...b.txs]) if (!keep.has(t.txid)) b.removeExistingTxid(t.txid);
  // Parents first (the funding BEEF sorted), then the swap LAST: the validator takes a V2 BEEF's last transaction as
  // its subject (skein-sdk chain/src/beef.zig `subject`), and the SDK's writer sorts a swap whose pool input's source
  // is not in the BEEF to the front — so the V2 bytes are written here, in this order.
  b.sortTxs();
  return { beef: writeV2(b, swap), fundingTxid };
}

/** BEEF V2 (BRC-96): the bumps, then `b`'s transactions in their order, then `last` (raw, unproven). */
function writeV2(b: Beef, last: Transaction): number[] {
  const w = new Utils.Writer();
  w.writeUInt32LE(0xefbe0002); // BEEF V2
  w.writeVarIntNum(b.bumps.length);
  for (const m of b.bumps) w.write(m.toBinary());
  w.writeVarIntNum(b.txs.length + 1);
  for (const t of b.txs) {
    if (t.isTxidOnly) { w.writeUInt8(2); w.write(Utils.toArray(t.txid, "hex").reverse()); continue; }
    const raw = t.rawTx ?? t.tx!.toBinary();
    if (t.bumpIndex !== undefined) { w.writeUInt8(1); w.writeVarIntNum(t.bumpIndex); } else w.writeUInt8(0);
    w.write(raw);
  }
  w.writeUInt8(0);
  w.write(last.toBinary());
  return w.toArray();
}

/** The package's nonce (amm-p2p 0.43.0 `nonceOf`): the first 16 bytes of sha256("amm-swap-relay" ‖ sha256(swap)). */
export function nonceOf(swapRaw: number[]): Uint8Array {
  const id = Hash.sha256(swapRaw);
  return Uint8Array.from(Hash.sha256([...Utils.toArray("amm-swap-relay", "utf8"), ...id]).slice(0, 16));
}

// ---------------------------------------------------------------- the route

/** What the relay needs of the host (skein 0.3.1's Router and P2PHost; tests' fakes). */
export interface RelayHost {
  router: Router;
  sk: Skein;
  log(line: string): void;
}

export class Relay {
  private readonly o: RelayHost;
  constructor(o: RelayHost) { this.o = o; }
  private get r(): Router { return this.o.router; }

  /** `POST /@<tokenId>/amm/swap`, or undefined when the request is not this route's. */
  async route(handle: string, route: string, req: RouterRequest, signal?: AbortSignal): Promise<RouterResponse | undefined> {
    if (route !== SWAP_ROUTE || req.method !== "POST") return undefined;
    return await this.swap(handle, req.body, signal);
  }

  /** One swap relayed: the commission rule, the package, the call, the validator's BEEF into this overlay, the answer. */
  async swap(tokenId: string, raw: Uint8Array, signal?: AbortSignal): Promise<RouterResponse> {
    const row = TOKEN_ID.test(tokenId) ? this.r.o.db.get(tokenId) : undefined;
    if (!row || row.status !== "enabled") return problem(404, "ERR_NOT_FOUND", `no enabled token ${tokenId} on this exchange`);
    let body: Rec;
    try { body = JSON.parse(new TextDecoder().decode(raw)) as Rec; } catch { return problem(400, "ERR_BAD_REQUEST", "the body is not JSON {funding, swap, pool, validator, peerId}"); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return problem(400, "ERR_BAD_REQUEST", "the body is not {funding, swap, pool, validator, peerId}");
    const extra = Object.keys(body).filter((k) => !["funding", "swap", "pool", "validator", "peerId"].includes(k));
    if (extra.length) return problem(400, "ERR_BAD_REQUEST", `${extra[0]}: not in the shape {funding, swap, pool, validator, peerId}`);
    const funding = dagBytes(body.funding), swapRaw = dagBytes(body.swap), validator = dagBytes(body.validator);
    const pool = body.pool, peerId = body.peerId;
    if (!funding?.length) return problem(400, "ERR_BAD_REQUEST", "funding: want bytes (the funding transaction's Atomic BEEF)");
    if (!swapRaw?.length) return problem(400, "ERR_BAD_REQUEST", "swap: want bytes (the raw swap)");
    if (typeof pool !== "string" || !OUTPOINT.test(pool)) return problem(400, "ERR_BAD_REQUEST", "pool: want <txid>_<vout>");
    if (!validator || validator.length !== 33 || (validator[0] !== 2 && validator[0] !== 3)) return problem(400, "ERR_BAD_REQUEST", "validator: want 33 bytes, a compressed identity key");
    if (typeof peerId !== "string" || !peerId) return problem(400, "ERR_BAD_REQUEST", "peerId: want the validator's libp2p peer ID");
    let swap: Transaction;
    try { swap = Transaction.fromBinary(Array.from(swapRaw)); } catch (e) { return problem(400, "ERR_BAD_REQUEST", `swap: not a transaction: ${(e as Error).message}`); }
    if (Buffer.compare(Buffer.from(swap.toBinary()), Buffer.from(swapRaw)) !== 0) return problem(400, "ERR_BAD_REQUEST", "swap: the raw transaction, nothing else");

    // 1. The commission rule (the one check that is the exchange's).
    let ours: Uint8Array;
    try { ours = await this.commissionPkh(tokenId); } catch (e) { return problem(503, "ERR_UNAVAILABLE", `this exchange's commission key: ${(e as Error).message}`); }
    const refused = commissionRule(swap, ours);
    if (refused) { this.o.log(`${tokenId}: swap on ${pool}: refused, nothing relayed (${refused.reason}: ${refused.detail})`); return answer(200, { ok: false, ...refused }); }

    // 2. The package, signed with the token instance's key outside any step.
    let pkg: Uint8Array;
    try {
      const { beef } = requestBeef(funding, swap);
      const cid = this.o.sk.cid;
      const bodyBytes = cid.encode({ tx: Uint8Array.from(beef), pool }).bytes;
      const m = await this.r.signMessage(tokenId, { recipient: validator, box: "swap", body: bodyBytes, nonce: nonceOf(Array.from(swapRaw)) });
      pkg = cid.encode({ message: m.message, body: m.body, topic: `tm_color_${tokenId}` }).bytes;
    } catch (e) { return problem(400, "ERR_BAD_REQUEST", `the validator's package: ${(e as Error).message}`); }

    // 3. Carried: to the peer on one stream, or to this node's own validator as an inbound frame.
    const local = this.isLocal(tokenId, peerId);
    let frame: Uint8Array;
    try {
      if (signal?.aborted) throw new Error("the call was cancelled: the page's request closed");
      frame = local ? await this.localFrame(tokenId, peerId, pkg) : (await this.r.p2p!.call(tokenId, peerId, SWAP_PROTOCOL, pkg, signal ? { signal } : {})).body;
    } catch (e) {
      const why = (e as Error).message;
      this.o.log(`${tokenId}: swap on ${pool} to ${peerId}: ${why}`);
      return answer(200, { ok: false, reason: "unreachable", detail: why });
    }
    let reply: Rec;
    try { reply = this.o.sk.cid.decode(frame) as Rec; } catch { return answer(200, { ok: false, reason: "unreachable", detail: "the validator's answer is not dag-cbor" }); }
    if (!reply || typeof reply !== "object" || typeof reply.ok !== "boolean") {
      const k = reply as { kind?: unknown; message?: unknown } | null;
      return answer(200, { ok: false, reason: "unreachable", detail: k?.kind === "error" && typeof k.message === "string" ? `the validator's host: ${k.message}` : "the validator's answer has no ok" });
    }

    // 4. Its BEEF into this overlay first (another node's state), so the page's next read reflects it.
    if (!local && reply.beef instanceof Uint8Array && reply.beef.length) await this.submit(tokenId, reply.beef);
    this.o.log(`${tokenId}: swap on ${pool} via ${local ? "this node's validator" : peerId}: ${reply.ok ? `accepted ${String(reply.txid).slice(0, 8)}…` : `refused ${String(reply.reason)}`}`);
    // 5. The validator's reply as it is.
    return answer(200, reply);
  }

  /** hash160 of the token instance's own key for the commission (its signer: [1, "amm commission"], "relay", anyone, forSelf). */
  private async commissionPkh(tokenId: string): Promise<Uint8Array> {
    const l = await this.r.hydrate(tokenId);
    const { publicKey } = await l.wallet.getPublicKey({ protocolID: COMMISSION_PROTOCOL, keyID: COMMISSION_KEY_ID, counterparty: "anyone", forSelf: true });
    return Uint8Array.from(Hash.hash160(Utils.toArray(publicKey, "hex")));
  }

  /** Whether `peerId` is this host's own node for the token instance (one node per key). */
  private isLocal(tokenId: string, peerId: string): boolean {
    try { return this.r.p2p?.peerId(tokenId) === peerId; } catch { return false; }
  }

  /** The package to this node's own validator: the node's inbound frame (Router.p2pInbound), as any peer's frame. */
  private async localFrame(tokenId: string, peerId: string, pkg: Uint8Array): Promise<Uint8Array> {
    const a = await this.r.p2pInbound(tokenId, { transport: "libp2p", protocol: SWAP_PROTOCOL, from: Uint8Array.from(Utils.fromBase58(peerId)), body: pkg });
    if (!a.body) throw new Error(`this node's validator answered no frame (${a.verdict}${a.reason ? `: ${a.reason}` : ""})`);
    return a.body;
  }

  /** The validator's BEEF to the token instance's overlay, in process (POST /submit, the token topic); its answer awaited. */
  private async submit(tokenId: string, beef: Uint8Array): Promise<void> {
    const r = await this.r.dispatch({
      method: "POST", url: `${this.r.origin()}/@${tokenId}/submit`,
      headers: { "content-type": "application/octet-stream", "x-topics": JSON.stringify([`tm_color_${tokenId}`]) }, body: beef,
    }).catch((e: Error) => ({ status: 0, body: enc(e.message) }) as RouterResponse);
    if (r.status !== 200) this.o.log(`${tokenId}: the validator's BEEF into this overlay: ${r.status} ${new TextDecoder().decode(r.body).slice(0, 200)}`);
  }
}
