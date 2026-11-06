// The exchange's wallet read (0.15.0): GET <origin>/amm/wallet, answered by the HOST (skein's Router
// option `appRead`, at swap) from swap's core wallet state — the head `wallet/state` and the records it
// names, read from swap's store: no step, no log entry.
//
//   GET /amm/wallet   {sats, outputs, withdrawals: [{n, txid, sats, at}]}   the coins the wallet's builder spends
//                      (docs/WALLET.md, skein): its outputs in the basket `default` with protocol `wallet payment`
//                      or `wallet change` (the paid enables' payments, the wallet's change), less those its own
//                      actions spent (the map `spent`); `sats` their total, `outputs` their count; `withdrawals`
//                      the swap app's head `amm/withdrawals` (the admin's withdrawals, kept when proven).
//   GET /amm/wallet/tx?n=<n>   that withdrawal's Atomic BEEF (application/octet-stream); 404 when none.
//
// The wallet-state record: {kind: "wallet-state", maps: {actions, outputs, byBasket, spent, drafts}}, each a
// merkle search tree [left, [[key, value, right], …]] (skein-sdk mst.zig); `outputs`: txid ‖ vout (u32 BE) →
// the output record {txid, vout, tx: <the transaction's CID>, basket, protocol, …}; `spent`: txid ‖ vout →
// the spending txid. A coin's satoshis are its transaction's (the raw bytes under `tx`).
import type { Router, Skein } from "./skein.ts";

type RouterResponse = import("@dcasegr/skein/dist/host/router.js").RouterResponse;
type CID = import("multiformats/cid").CID;
type Rec = Record<string, unknown>;
type Node = [CID | null, Array<[Uint8Array, unknown, CID | null]>];

export const WALLET_ROUTE = "/amm/wallet";
export const WALLET_TX_ROUTE = "/amm/wallet/tx";
/** The swap app's kept withdrawals (apps/swap paid.zig). */
export const WITHDRAWALS_HEAD = "amm/withdrawals";
export const WALLET_HEAD = "wallet/state";
/** The protocols of the coins the wallet's builder spends. */
const SPENDABLE = new Set(["wallet payment", "wallet change"]);

export interface Withdrawal { n: number; txid: string; sats: number; at: number }
export interface WalletView { sats: number; outputs: number; withdrawals: Withdrawal[] }

/** swap's kept withdrawals, each with its Atomic BEEF (the head amm/withdrawals). */
async function withdrawals(sk: Skein, router: Router, handle: string): Promise<Array<Withdrawal & { beef: Uint8Array }>> {
  const l = await router.hydrate(handle);
  const head = await l.kernel.call("head", WITHDRAWALS_HEAD) as CID | null;
  if (!head) return [];
  const rec = await l.kernel.store.get(head as never) as unknown as { kind?: string; withdrawals?: Array<Record<string, unknown>> };
  if (rec?.kind !== "amm-withdrawals") return [];
  return (rec.withdrawals ?? []).map((w) => ({ n: Number(w.n), txid: String(w.txid), sats: Number(w.sats), at: Number(w.at), beef: w.beef as Uint8Array }));
}

const isCid = (v: unknown): v is CID => !!v && typeof v === "object" && (v as { asCID?: unknown }).asCID === v;

/** Output `vout`'s satoshis in a raw transaction (version, inputs, outputs: the standard serialization). */
export function outputSats(raw: Uint8Array, vout: number): number {
  let i = 4;
  const varint = (): number => {
    const b = raw[i++]!;
    if (b < 0xfd) return b;
    const n = b === 0xfd ? 2 : b === 0xfe ? 4 : 8;
    let v = 0;
    for (let k = 0; k < n; k++) v += raw[i + k]! * 2 ** (8 * k);
    i += n;
    return v;
  };
  const ins = varint();
  for (let k = 0; k < ins; k++) { i += 36; const n = varint(); i += n + 4; }
  const outs = varint();
  for (let k = 0; k < outs; k++) {
    const lo = raw[i]! + raw[i + 1]! * 2 ** 8 + raw[i + 2]! * 2 ** 16 + raw[i + 3]! * 2 ** 24;
    const hi = raw[i + 4]! + raw[i + 5]! * 2 ** 8 + raw[i + 6]! * 2 ** 16 + raw[i + 7]! * 2 ** 24;
    if (k === vout) return lo + hi * 2 ** 32;
    i += 8;
    const n = varint();
    i += n;
  }
  throw new Error(`no output ${vout}`);
}

/** swap's wallet as GET /amm/wallet answers it. */
export async function walletView(sk: Skein, router: Router, handle: string): Promise<WalletView> {
  const row = router.o.db.get(handle);
  if (!row) throw new Error(`no instance ${handle}`);
  const l = await router.hydrate(handle);
  const head = await l.kernel.call("head", WALLET_HEAD) as CID | null;
  const kept = (await withdrawals(sk, router, handle)).map(({ beef: _b, ...w }) => w);
  if (!head) return { sats: 0, outputs: 0, withdrawals: kept };
  const st = sk.stores.openStoreFile(sk.indexStore.storeSpec(row), { readOnly: true });
  try {
    const state = await st.get(head as never) as unknown as { kind?: string; maps?: Record<string, CID | null> };
    if (state?.kind !== "wallet-state") throw new Error(`${WALLET_HEAD} is not a wallet-state record`);
    const walk = async function* (root: CID | null | undefined): AsyncGenerator<[Uint8Array, unknown]> {
      if (!root) return;
      const [left, es] = sk.cid.decode<Node>(await st.bytes(root as never));
      yield* walk(left);
      for (const [k, v, right] of es) { yield [k, v]; yield* walk(right); }
    };
    const spent = new Set<string>();
    for await (const [k] of walk(state.maps?.spent)) spent.add(Buffer.from(k).toString("hex"));
    let sats = 0, outputs = 0;
    for await (const [k, v] of walk(state.maps?.outputs)) {
      if (spent.has(Buffer.from(k).toString("hex"))) continue;
      const out = (isCid(v) ? await st.get(v as never) : v) as unknown as Rec;
      if (out.basket !== "default" || !SPENDABLE.has(String(out.protocol))) continue;
      sats += outputSats(await st.bytes(out.tx as never), Number(out.vout));
      outputs++;
    }
    return { sats, outputs, withdrawals: kept };
  } finally { st.close(); }
}

/** RouterOptions.appRead's share: GET /amm/wallet and /amm/wallet/tx?n= at swap; anything else undefined. */
export async function walletRead(sk: Skein, router: Router, swap: string, handle: string, route: string, url: URL): Promise<RouterResponse | undefined> {
  if (handle !== swap) return undefined;
  const problem = (status: number, code: string, description: string): RouterResponse => ({ status, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify({ status: "error", code, description })) });
  if (route === WALLET_TX_ROUTE) {
    const n = Number(url.searchParams.get("n"));
    if (!Number.isSafeInteger(n) || n < 1) return problem(400, "ERR_BAD_REQUEST", "want ?n=<the withdrawal's number, from 1>");
    const w = (await withdrawals(sk, router, handle)).find((x) => x.n === n);
    if (!w) return problem(404, "ERR_NOT_FOUND", `no withdrawal ${n}`);
    return { status: 200, headers: { "content-type": "application/octet-stream" }, body: w.beef };
  }
  if (route !== WALLET_ROUTE) return undefined;
  let v: WalletView;
  try { v = await walletView(sk, router, handle); } catch (e) {
    return { status: 503, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify({ status: "error", code: "ERR_UNAVAILABLE", description: (e as Error).message })) };
  }
  return { status: 200, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(v)) };
}
