// open-exchange#1 acceptance: the Open Exchange host on a scratch one-key host (regtest; the wasm kernel
// over the host's one SQLite database by default — the distributable's shape; RocksDB with the native
// kernel process with SKEIN_EQUIV_STORE=rocksdb, a native serve per SQLite file with =file), through the commands' own code (host/cli.ts `firstRun`,
// `startExchange`) and the front door over HTTP (root's messages by BRC-104, as a wallet sends them).
//
//   zero config          → `open-exchange` (bin, no arguments) in a clean SKEIN_HOME with NOTHING else set (no network):
//                          the first run writes host.env (key, SQLite, swap at the root, SKEIN_NETWORK=test — no
//                          bootstrap line) and the key, makes swap + discovery, then runs: the testnet Arcade with a
//                          token it made into host.env, the testnet overlay bootstrap (ovh) dialled, the Teranode
//                          first sync from the network's hub; then a wallet claims swap. Real network (testnet; minutes:
//                          the first sync). OX_ACCEPT_ZERO=off skips it
//   the first run        → (regtest) swap and discovery born owned by the host's key (0.5.0); /amm/admin {} (unclaimed);
//                          discovery serving tm_color and ls_color; a stranger's message in amm/admin runs nothing
//   the claim            → the admin's own {fn: "claim"} in box `amm/claim` (BRC-104, as the Settings page sends it):
//                          /amm/admin names it, the host grants it amm.admin; root stays [host]; /skeins?key=<admin>
//                          does not list swap; a second claim by another key refused
//   run                  → reconciled: swap's discovery is off, so discovery stopped
//   root: defaults terms (0.14.0: with minLegSats), then enable {tokenId, beef}   → the host reacts: the instance <id> born owned, its deploy
//                          event admitted (amm/token), the three names served, beats, the terms sent;
//                          bare-host /lookup ls_color_<id> routed; /amm/tokens: enabled, no url
//   disable              → stopped (404 at /@<id>); enable again (no BEEF), by root (the host's key) → started
//   terms {tokenId, terms} → (0.12.0) the event token-terms; the host sends root's terms to the token instance
//                          (/@<id>/amm/terms follows; null = market only); a token not on the list refused
//   the paid enable      → (0.15.3) a BEEF submission: POST /amm/enable?tokenId=&paymentTxid=&paymentVout=&derivationPrefix=
//                          &derivationSuffix=, signed, ONE BEEF with the deploy and the payment: off → 403; no payment
//                          named → 402 with the price; no deploy → 400; too small → 402; a wrong key → 400; a good
//                          bundle → enabled with the default terms, the coin in swap's wallet (sent on by its
//                          internalize); the same payment for another token → 409; a second request → 409; disabled by
//                          the admin → 409; the admin's withdraw (0.15.2) → a payment handed over unsent
//   discovery off / on   → stopped / started; (0.15.1) the list's q (symbol / token id prefix) and after (paging)
//   restart the host     → reconcile creates nothing and starts what swap says
//   history (0.13.0; 0.14.0) → a second token B from the token app's own fixtures (src/fixtures/vectors.zig: its deploy,
//                          a pool, a sats-in and a token-in Swap, the LP's Close; the host's key is the fixtures'
//                          validator identity, so B's pool is listed under a beating validator): the pool event feeds
//                          /@<B>/amm/events and /amm/events send deploy, swap, swap, close (nothing on connect; A's
//                          feed none); /@<B>/amm/pools/at, /pools/history, /trades, /candles (fill and market), /stats
//                          (price over the listed pools); the host's /amm/stats, /amm/positions?pool=, /amm/spends;
//                          B's holders; then B's other lineage on a SECOND host (the fixtures' swap_token_change
//                          competes with swap_tokens_in): deploy → sats-in swap → a swap WITH token change → its close
//   one swap per pool    → (0.16.0) on hosts of their own: two, then three, swaps on one pool output relayed at once
//                          through the host's own relay before either is admitted → exactly one accepted, the others
//                          pool_spent with its continuation; the pools route at the new outpoint, its trade row;
//                          (0.17.0) CROSS-HOST: the relay on another host (another key), the validator's host reached by
//                          the relay host's `call` intention over libp2p: two at once → one accepted, one pool_spent;
//                          then the validator's host stopped → a call to it `failed` `unreachable` at once, the page's
//                          one re-ask relayed again and failed the same way
//   swap's pages         → a restart with a packaged swap app of another version installs it into swap (as root),
//                          the same version installs nothing; swap's state and the claimant's grant kept
//   every store replays to itself — by the NATIVE reference (`skein-kernel replay`, skein's
//   kernel-zig/equiv/replays.ts) when SKEIN_REPLAY_DIR names a skein checkout with its kernel built;
//   a store the wasm kernel wrote is then checked against the native kernel's replay of it
//
//   [SKEIN_REPLAY_DIR=<skein checkout>] [SKEIN_KERNEL_BIN=<a native kernel>] [SKEIN_EQUIV_STORE=rocksdb|file] node scripts/accept/ox-accept.ts
//   (built: node dist/scripts/accept/ox-accept.js — what a package install runs)
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as httpServer, type ServerResponse } from "node:http";
import { createServer } from "node:net";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DISCOVERY, SWAP } from "../../host/exchange.ts";
import { load, OX_ROOT, skein, SWAP_APP_DIR, swapAppVersion } from "../../host/skein.ts";
import { firstRun, main, settings, startExchange, type Env, type Running } from "../../host/cli.ts";
import { changeBps, marketCandles, mergeStats, poolState } from "../../host/pools.ts";
import { priceOf } from "@dcasegr/amm-engine";

type Sdk = typeof import("@bsv/sdk");
// @bsv/sdk as skein's own dependency (resolved from the skein package).
const sdkCjs = createRequire(fileURLToPath(import.meta.resolve("@dcasegr/skein/package.json"))).resolve("@bsv/sdk");
const sdk = await import(pathToFileURL(sdkCjs).href) as Sdk;
// 0.15.0: the paid enable's payer — AuthFetch and its wallet's keys from the sdk's ESM build, as skein's keyWallet is.
const esm = await import(pathToFileURL(join(dirname(sdkCjs), "../esm/mod.js")).href) as Sdk;
const { KeyDeriver, LockingScript, MerklePath, P2PKH, PrivateKey, Transaction, UnlockingScript } = sdk;
const sk = await load();
const { RawBox } = sk.raw;
const { keyWallet } = await skein<typeof import("@dcasegr/skein/dist/wallet.js")>("src/wallet.ts");
const { FakeArcade } = await skein<typeof import("@dcasegr/skein/dist/host/fake-arcade.js")>("src/host/fake-arcade.ts");
const ROCKS = process.env.SKEIN_EQUIV_STORE === "rocksdb";
const FILE = process.env.SKEIN_EQUIV_STORE === "file";
const BACKEND = ROCKS ? "rocksdb" : FILE ? "sqlite files, native serve" : "wasm";
const REPLAY_DIR = process.env.SKEIN_REPLAY_DIR;
const kernel = process.env.SKEIN_KERNEL_BIN ?? (REPLAY_DIR ? join(REPLAY_DIR, "kernel-zig/zig-out/bin/skein-kernel") : undefined);

let failures = 0;
const check = (ok: boolean, what: string) => { process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}\n`); if (!ok) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, f: () => Promise<T | undefined> | T | undefined, ms = 30_000): Promise<T | undefined> {
  for (const end = Date.now() + ms; ;) {
    const v = await Promise.resolve().then(f).catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) { process.stdout.write(`  (timed out waiting for ${what})\n`); return undefined; }
    await sleep(150);
  }
}
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

// ---------------------------------------------------------------- regtest (as skein-amm's amm-setup-accept.ts)
const sha256d = (b: Uint8Array) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const internal = (displayHex: string) => Buffer.from(displayHex, "hex").reverse();
const REGTEST_GENESIS = Buffer.from("0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4adae5494dffff7f2002000000", "hex");
const TARGET = 0x7fffffn << BigInt(8 * (0x20 - 3));
function mine(prev: Uint8Array, merkleRoot: Uint8Array, time: number): Uint8Array {
  const h = Buffer.alloc(80);
  h.writeInt32LE(1, 0);
  Buffer.from(prev).copy(h, 4);
  Buffer.from(merkleRoot).copy(h, 36);
  h.writeUInt32LE(time, 68);
  h.writeUInt32LE(0x207fffff, 72);
  for (let nonce = 0; ; nonce++) {
    h.writeUInt32LE(nonce, 76);
    if (BigInt("0x" + Buffer.from(sha256d(h)).reverse().toString("hex")) <= TARGET) return new Uint8Array(h);
  }
}
const headers: Uint8Array[] = [mine(sha256d(REGTEST_GENESIS), sha256d(Buffer.concat([internal("cb".repeat(32)), internal("cc".repeat(32))])), 1_790_200_000)];
function mineAlone(t: InstanceType<typeof Transaction>, MP: typeof MerklePath = MerklePath): number {
  const height = headers.length + 1;
  const cb = (height * 17 % 256).toString(16).padStart(2, "0").repeat(32);
  t.merklePath = new MP(height, [[{ offset: 0, hash: cb }, { offset: 1, hash: t.id("hex"), txid: true }]]);
  headers.push(mine(sha256d(headers.at(-1)!), sha256d(Buffer.concat([internal(cb), internal(t.id("hex"))])), 1_790_200_000 + height * 600));
  return height;
}
const holder = new PrivateKey("3333", 16);
function deploy(seed: number, sym: string, dec: number) {
  const t = new Transaction();
  t.addInput({ sourceTXID: seed.toString(16).padStart(2, "0").repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  const lock = new P2PKH().lock(holder.toPublicKey().toHash());
  const s = new LockingScript().writeOpCode(0x00).writeNumber(21_000_000).writeOpCode(0x6d).writeBin(Array.from(sk.cid.encode({ sym, dec }).bytes)).writeOpCode(0x75);
  t.addOutput({ lockingScript: LockingScript.fromBinary([...s.toBinary(), ...lock.toBinary()]), satoshis: 1 });
  return t;
}

// ---------------------------------------------------------------- pools (0.11.0: GET /amm/pools, /@<id>/amm/pools)
// A pool output as skein-amm writes it (src/pool.zig, docs/AMM.md): the 1Color value prefix, the Pool code
// (its template with the readonly args spliced in at the slots), OP_RETURN, the state (TokenReserve,
// LpPubKey, ValidatorPubKey, ValidatorIdentity, Nonce, the Affirmation). The template comes from the
// token app's own tree (src/fixtures/pool_artifact.zig) as the instance holds it.
const le64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt.asUintN(64, v)); return b; };
const valueScript = (assetId: Uint8Array, amount: number, lock: InstanceType<typeof LockingScript>) =>
  LockingScript.fromBinary([...new LockingScript().writeBin(Array.from(assetId)).writeNumber(amount).writeOpCode(0x6d).toBinary(), ...lock.toBinary()]);
interface PoolTemplate { code: Buffer; slots: Array<{ offset: number; param: number }> }
function templateOf(zig: string): PoolTemplate {
  const hex = /script_hex = "([0-9a-f]+)"/.exec(zig)?.[1];
  const slots = [...zig.matchAll(/\.offset = (\d+), \.param = (\d+)/g)].map((m) => ({ offset: Number(m[1]), param: Number(m[2]) }));
  if (!hex || !slots.length) throw new Error("pool_artifact.zig: no script_hex / slots");
  return { code: Buffer.from(hex, "hex"), slots: slots.sort((a, b) => a.offset - b.offset) };
}
/** A deploy pool (the lookup's rule: affirmed by its ValidatorIdentity's child keyed by its Nonce), signed by `identity`. */
function poolScript(t: PoolTemplate, o: { assetId: Uint8Array; reserve: number; sats: number; fees: [number, number, number]; lp: string; identity: InstanceType<typeof PrivateKey> }) {
  const code: number[] = [];
  let at = 0;
  for (const s of t.slots) {
    if (t.code[s.offset] !== 0x00) throw new Error(`pool template: no placeholder at ${s.offset}`);
    code.push(...t.code.subarray(at, s.offset));
    code.push(...(s.param === 6 ? [0x20, ...o.assetId] : new LockingScript().writeNumber(o.fees[s.param - 7]!).toBinary()));
    at = s.offset + 1;
  }
  code.push(...t.code.subarray(at));
  const nonce = createHash("sha256").update(`pool ${o.lp}`).digest();
  const child = new KeyDeriver(o.identity).derivePrivateKey([1, "amm pool"], nonce.toString("hex"), "anyone");
  const lp = Buffer.from(o.lp, "hex"), validator = Buffer.from(child.toPublicKey().toDER() as number[]), identity = Buffer.from(o.identity.toPublicKey().toDER() as number[]);
  const msg = Buffer.concat([Buffer.from("skein-amm affirm 2"), o.assetId, ...o.fees.map((f) => le64(BigInt(f))), le64(BigInt(o.reserve)), le64(BigInt(o.sats)), lp, validator, identity, nonce]);
  const der = Buffer.from(child.sign(Array.from(msg)).toDER() as number[]);
  const state = Buffer.concat([le64(BigInt(o.reserve)), lp, validator, identity, nonce, Buffer.from([der.length]), der]);
  const prefix = new LockingScript().writeBin(Array.from(o.assetId)).writeNumber(o.reserve).writeOpCode(0x6d).toBinary();
  return LockingScript.fromBinary([...prefix, ...code, 0x6a, ...state]);
}
/** A pool event feed's messages (0.14.0: `event: pool`, `data: {tokenId, …row}`), as they come; `other` any other event's; `close` ends it. */
function poolFeed(url: string) {
  const ac = new AbortController();
  const got: Array<Record<string, unknown>> = [];
  const other: string[] = [];
  let status = 0, type = "";
  const done = (async () => {
    const res = await fetch(url, { headers: { accept: "text/event-stream" }, signal: ac.signal });
    status = res.status;
    type = res.headers.get("content-type") ?? "";
    const reader = res.body!.getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += new TextDecoder().decode(value);
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
        const ev = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = /^data: (.*)$/m.exec(ev)?.[1];
        if (/^event: pool$/m.test(ev) && data !== undefined) got.push(JSON.parse(data)); else other.push(ev);
      }
    }
  })().catch(() => {});
  return { got, other, status: () => status, type: () => type, close: () => { ac.abort(); return done; } };
}

// ---------------------------------------------------------------- the headers feed (SSE, hex), as SKEIN_HEADERS_URL
const streams = new Set<ServerResponse>();
const sse = httpServer((req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  streams.add(res);
  req.on("close", () => streams.delete(res));
  // From the regtest genesis (height 0): a fresh host's image chain starts there.
  res.write(`id: 0\ndata: ${REGTEST_GENESIS.toString("hex")}\n\n`);
  headers.forEach((h, i) => res.write(`id: ${i + 1}\ndata: ${Buffer.from(h).toString("hex")}\n\n`));
});
/** A new block: on every open stream, as a live feed sends it. */
const pushHeader = () => { const i = headers.length; for (const s of streams) s.write(`id: ${i}\ndata: ${Buffer.from(headers[i - 1]!).toString("hex")}\n\n`); };
await new Promise<void>((r) => sse.listen(0, "127.0.0.1", r));
const feedUrl = `http://127.0.0.1:${(sse.address() as { port: number }).port}/headers`;

// ---------------------------------------------------------------- zero config: `open-exchange`, nothing set
/** `open-exchange` (the bin, no arguments) in a clean SKEIN_HOME with nothing else set; a wallet claims swap; stopped. */
async function zeroConfig(): Promise<void> {
  const zhome = join(mkdtempSync(join(tmpdir(), "ox-zero-")), "home");
  const bin = join(OX_ROOT, "bin", "open-exchange.js");
  const busy = await new Promise<boolean>((resolve) => { const s = createServer(); s.once("error", () => resolve(true)); s.listen(8100, () => s.close(() => resolve(false))); });
  if (busy) { check(false, "zero config: port 8100 (the default) is taken on this box: stop what holds it, or OX_ACCEPT_ZERO=off"); return; }
  const out: string[] = [];
  const child = spawn(process.execPath, [bin], { env: { HOME: process.env.HOME, PATH: process.env.PATH, SKEIN_HOME: zhome }, stdio: ["ignore", "pipe", "pipe"] });
  const take = (tag: string) => (b: Buffer) => { for (const l of b.toString("utf8").split("\n").filter(Boolean)) { out.push(`${tag}${l}`); if (process.env.VERBOSE) process.stdout.write(`  z ${tag}${l}\n`); } };
  child.stdout.on("data", take(""));
  child.stderr.on("data", take("ERR "));
  let exited: number | null | undefined;
  child.on("exit", (c) => { exited = c; });
  const t0 = Date.now();
  try {
    const ready = await until("the first run's ready line", () => exited !== undefined ? "exited" : out.find((l) => /^open-exchange: ready — open http:\/\/127\.0\.0\.1:8100\//.test(l)), 15 * 60_000);
    check(!!ready && ready !== "exited", `zero config: \`open-exchange\` with only SKEIN_HOME set: ready in ${Math.round((Date.now() - t0) / 1000)} s (${ready ?? "no ready line"})`);
    const firstLines = out.filter((l) => /^open-exchange: /.test(l) || /Arcade callback token made/.test(l));
    process.stdout.write(`  the first run's own lines:\n${firstLines.map((l) => `    ${l}`).join("\n")}\n`);
    if (process.env.OX_ZERO_LOG) writeFileSync(process.env.OX_ZERO_LOG, out.join("\n") + "\n");
    const henv = existsSync(join(zhome, "host.env")) ? readFileSync(join(zhome, "host.env"), "utf8") : "";
    const keys = henv.split("\n").filter((l) => /^SKEIN_/.test(l)).map((l) => l.split("=")[0]).sort().join(" ");
    check(keys === "SKEIN_ARC_TOKEN SKEIN_KEY_FILE SKEIN_NETWORK SKEIN_ROOT_INSTANCE SKEIN_STORE_SQLITE", `zero config: host.env holds only ${keys}`);
    check(/^SKEIN_NETWORK=test$/m.test(henv) && /^SKEIN_ARC_TOKEN=[0-9a-f]{64}$/m.test(henv) && !/BOOTSTRAP/.test(henv), "zero config: host.env names network test and a made SKEIN_ARC_TOKEN, and no bootstrap line");
    check(existsSync(join(zhome, "key")) && /^[0-9a-f]{64}$/.test(readFileSync(join(zhome, "key"), "utf8").trim()), "zero config: the host's key made");
    check(out.some((l) => l.includes("broadcast events → Arcade https://testnet.arcade.1sat.app")), "zero config: the log names the testnet Arcade (the network's default)");
    check(out.some((l) => /libp2p: the host node, peer .*bootstrap \/dns4\/p2p\.testnet\.openex\.dev\/tcp\/7534\/p2p\/16Uiu2HAmVN7Cc7TrFGVrbdoV1mMGBF8LQBvPZ5trzgPArfagBRSB/.test(l)), "zero config: the host node's bootstrap is the testnet overlay node (ovh), the network's default");
    const Z = "http://127.0.0.1:8100";
    const zget = async (p: string) => { const r = await fetch(`${Z}${p}`); return r.status === 200 ? await r.json() as Record<string, unknown> : undefined; };
    const wk = await zget(`/@${SWAP}/.well-known/skein`) ?? await zget("/.well-known/skein");
    check(wk?.handle === SWAP && typeof wk.identity === "string", `zero config: swap exists (${JSON.stringify(wk)})`);
    const disc = await fetch(`${Z}/@${DISCOVERY}/1color/listTopicManagers`);
    check([200, 404].includes(disc.status) && out.some((l) => /made .*discovery/.test(l)), `zero config: discovery made (stopped until swap's switch: ${disc.status})`);
    check((await fetch(`${Z}/`)).status === 200, "zero config: GET / serves swap's pages");
    const zadmin = sk.hostenv.parseKey("1f".repeat(32), "zero admin");
    await new RawBox(keyWallet(zadmin), `${Z}/@${SWAP}`).send(wk!.identity as string, "amm/claim", { fn: "claim" });
    const zc = await until("the zero-config claim", async () => { const a = await zget(`/@${SWAP}/amm/admin`) as { claimant?: string } | undefined; return a?.claimant ? a : undefined; }, 60_000);
    check(zc?.claimant === zadmin.toPublicKey().toString(), `zero config: a wallet claims swap (/amm/admin ${JSON.stringify(zc)})`);
  } finally {
    if (exited === undefined) {
      child.kill("SIGTERM");
      await until("the zero-config host to stop", () => exited !== undefined ? true : undefined, 120_000);
      if (exited === undefined) child.kill("SIGKILL");
    }
    if (process.env.KEEP) process.stdout.write(`kept ${zhome}\n`); else rmSync(dirname(zhome), { recursive: true, force: true });
  }
}
if ((process.env.OX_ACCEPT_ZERO ?? "").toLowerCase() !== "off") await zeroConfig().catch((e) => check(false, `zero config threw: ${(e as Error).stack}`));
else process.stdout.write("  (zero config skipped: OX_ACCEPT_ZERO=off)\n");

// ---------------------------------------------------------------- the host
const home = mkdtempSync(join(tmpdir(), "ox-accept-"));
// 0.13.0: the token app's fixtures' validator identity (skein-amm gen/vectors: key(0x7f)), so the fixture pool
// of the history checks is listed under this host's beating validator.
const shared = new PrivateKey("7f".repeat(32), 16);
const SHARED = shared.toPublicKey().toString();
const admin = sk.hostenv.parseKey("0f".repeat(32), "admin");
const ADMIN = admin.toPublicKey().toString();
writeFileSync(join(home, "key"), `${shared.toHex()}\n`, { mode: 0o600 });
const arcade = await FakeArcade.start();
const port = await freePort(), hostPort = await freePort(), p2pPort = await freePort();
const lines: string[] = [];
writeFileSync(join(home, "host.env"), [
  `SKEIN_KEY_FILE=${join(home, "key")}`,
  ...(ROCKS ? [`SKEIN_STORE_ROCKSDB=${join(home, "store-rocksdb")}`] : FILE ? [] : [`SKEIN_STORE_SQLITE=${join(home, "store.sqlite")}`]),
  `SKEIN_ROOT_INSTANCE=${SWAP}`,
  "SKEIN_NETWORK=regtest",
  `SKEIN_ROUTER_PORT=${port}`,
  `SKEIN_HOST_PORT=${hostPort}`,
  `SKEIN_HEADERS_URL=${feedUrl}`,
  `SKEIN_ARC_URL=${arcade.url}`, "SKEIN_ARC_TOKEN=t", `SKEIN_ARC_EVENTS_URL=${arcade.eventsUrl}`,
  `SKEIN_LIBP2P_LISTEN=/ip4/127.0.0.1/tcp/${p2pPort}`,
  ...(kernel ? [`SKEIN_KERNEL_BIN=${kernel}`] : []),
  "",
].join("\n"));
const env: Env = { vars: { HOME: process.env.HOME, PATH: process.env.PATH, SKEIN_HOME: home }, out: (l) => { lines.push(l); if (process.env.VERBOSE) process.stdout.write(`  | ${l}\n`); }, err: (l) => { lines.push(`ERR ${l}`); process.stdout.write(`  ! ${l}\n`); } };
const R = `http://127.0.0.1:${port}`;
const get = async (path: string, host?: string) => { const r = await fetch(`${R}${path}`, host ? { headers: { host } } : {}); return { status: r.status, text: await r.text() }; };
const getJson = async (path: string) => { const r = await get(path); return r.status === 200 ? JSON.parse(r.text) : undefined; };
const { localTarget } = await skein<typeof import("@dcasegr/skein/dist/client/target.js")>("src/client/target.ts");
/** An instance's holders of `role` (root by default), read from its store (running or stopped), sorted. */
const rootOf = async (_x: Running, h: string, role = "root") => {
  const t = localTarget(settings(sk, env).vars, h, keyWallet(admin));
  try {
    const v = await t.view();
    const root = v.heads.find((x) => x.name === "grants")?.root;
    const g = root ? await v.store.get(root) as { roles?: Record<string, Uint8Array[]> } : undefined;
    return (g?.roles?.[role] ?? []).map((b) => Buffer.from(b).toString("hex")).sort();
  } finally { await t.close(); }
};
const stores: Array<{ spec: string; h: string }> = [];
const keep = (x: Running, h: string) => { const r = x.db.get(h); if (r && !stores.some((s) => s.h === h)) stores.push({ spec: sk.indexStore.storeSpec(r), h }); };

let x: Running | undefined;
try {
  const dA = deploy(0x41, "AAA", 5);
  const A = `${dA.id("hex")}_0`;
  const tmA = `tm_color_${A}`, lsA = `ls_color_${A}`, ammA = `ls_amm_${A}`;

  // ------------------------------------------------ the first run (host.env and the key given: it makes the instances)
  const t0 = Date.now();
  const fr = await firstRun(sk, env);
  check(!fr.failed && fr.made.some((m) => m.startsWith(`${SWAP} `)) && fr.made.some((m) => m.startsWith(`${DISCOVERY} `)), `the first run: made ${fr.made.join("; ")} (${Date.now() - t0} ms)`);
  check(lines.some((l) => /made .*swap \(the pages; owned by the host's key, unclaimed\)/.test(l)), "the first run says: swap made, owned by the host's key, unclaimed");
  check(readFileSync(join(home, "host.env"), "utf8").includes("SKEIN_ARC_TOKEN=t\n") && !readFileSync(join(home, "host.env"), "utf8").includes("#"), "the given host.env kept as it was (its lines win; nothing appended)");
  const old = await main(["setup"], { ...env, err: (l) => lines.push(`ERR ${l}`) });
  check(old === 2 && lines.some((l) => /open-exchange setup: gone since 0\.6\.0/.test(l)), `open-exchange setup: gone (exit ${old})`);
  const again = await firstRun(sk, env);
  check(!again.failed && again.made.length === 0, "the first run again: a no-op (everything exists)");
  if (ROCKS) await sleep(1500); // the one-shot's kernel process lets the database go

  // ------------------------------------------------ run
  x = await startExchange(sk, settings(sk, env));
  const r = x.host.router;
  await x.exchange.idle();
  keep(x, SWAP); keep(x, DISCOVERY);
  check(lines.some((l) => l.includes(`swap: pages at ${swapAppVersion()} (the package's)`)), `run: swap's pages at the package's version (${swapAppVersion()}): nothing installed`);
  check((await rootOf(x, SWAP)).join() === SHARED, `swap: born owned by the host's key — root [host] (${(await rootOf(x, SWAP)).map((k) => k.slice(0, 8)).join(", ")})`);
  check((await rootOf(x, DISCOVERY)).join() === SHARED, "discovery: born owned by the host's key");
  const card = async (path: string) => await getJson(path) as { handle?: string; identity?: string; claimed?: boolean } | undefined;
  const swapId = x.db.get(SWAP)!.identity!;
  const c0 = await card("/.well-known/skein");
  check(c0?.handle === SWAP && c0.identity === swapId && c0.claimed === true, `GET /.well-known/skein at swap: claimed true (the host holds root) (${JSON.stringify(c0)})`);
  check(JSON.stringify(await getJson(`/@${SWAP}/amm/admin`)) === "{}" && JSON.stringify(await getJson("/amm/admin")) === "{}", "GET /amm/admin (bare host and /@swap/): {} — no claimant");
  const held = async (key: string) => (await getJson(`/skeins?key=${key}`) as Array<{ handle: string }> | undefined)?.map((h) => h.handle) ?? [];
  check((await held(ADMIN)).length === 0 && (await held(SHARED)).includes(SWAP), `/skeins?key=: the admin holds nothing; the host's key holds swap (${(await held(SHARED)).join(", ")})`);

  // ------------------------------------------------ the gate: a stranger's message in amm/admin runs nothing
  const other = sk.hostenv.parseKey("0d".repeat(32), "other");
  const OTHER = other.toPublicKey().toString();
  await new RawBox(keyWallet(other), `${R}/@${SWAP}`).send(swapId, "amm/admin", { fn: "defaults", args: { market: { minCommissionBps: 9 } } });
  await r.settled();
  await (await r.hydrate(SWAP)).kernel.idle();
  check(JSON.stringify(await getJson(`/@${SWAP}/amm/defaults`)) === '{"enablePriceSats":null}', `a stranger's defaults in amm/admin (unclaimed swap): gated, nothing written (${JSON.stringify(await getJson(`/@${SWAP}/amm/defaults`))})`);

  // ------------------------------------------------ the claim: the admin's own {fn: "claim"} in box amm/claim, as the Settings page sends it
  await new RawBox(keyWallet(admin), `${R}/@${SWAP}`).send(swapId, "amm/claim", { fn: "claim" });
  const claimedBy = await until("swap's /amm/admin names the admin", async () => { const a = await getJson(`/@${SWAP}/amm/admin`) as { claimant?: string } | undefined; return a?.claimant ? a : undefined; });
  check(claimedBy?.claimant === ADMIN && typeof (claimedBy as { since?: unknown }).since === "number", `the claim by the admin key: /amm/admin ${JSON.stringify(claimedBy)}`);
  const granted = await until("amm.admin granted", async () => { await x!.exchange.idle(); const g = await rootOf(x!, SWAP, "amm.admin"); return g.length ? g : undefined; });
  check(granted?.join() === ADMIN && lines.some((l) => l.includes(`claimed: amm.admin on swap granted to ${ADMIN}`)), `the host reacted to claimed: amm.admin on swap = [admin] (${granted?.map((k) => k.slice(0, 8)).join(", ")})`);
  check((await rootOf(x, SWAP)).join() === SHARED && !(await held(ADMIN)).includes(SWAP), `the admin is not root: root [host]; /skeins?key=<admin> does not list swap ([${(await held(ADMIN)).join(", ")}])`);
  await new RawBox(keyWallet(other), `${R}/@${SWAP}`).send(swapId, "amm/claim", { fn: "claim" });
  await r.settled();
  await (await r.hydrate(SWAP)).kernel.idle();
  await x.exchange.idle();
  check((await getJson(`/@${SWAP}/amm/admin`) as { claimant?: string }).claimant === ADMIN && (await rootOf(x, SWAP, "amm.admin")).join() === ADMIN && !(await rootOf(x, SWAP, "amm.admin")).includes(OTHER) && (await held(OTHER)).length === 0, "a second claim by another key: refused — /amm/admin and amm.admin unchanged");
  check(x.db.get(DISCOVERY)?.status === "disabled", `run: reconciled — swap's discovery is off, discovery stopped (${x.db.get(DISCOVERY)?.status})`);
  check((await get("/")).status === 200 && /<html/i.test((await get("/")).text), "GET / at the bare host: swap's pages (SKEIN_ROOT_INSTANCE)");
  check(JSON.stringify(await getJson(`/@${SWAP}/amm/tokens`)) === "[]" && JSON.stringify(await getJson(`/@${SWAP}/amm/discovery`)) === '{"on":false}', "swap: /amm/tokens [] and /amm/discovery {on:false}");

  const box = new RawBox(keyWallet(admin), `${R}/@${SWAP}`);
  const send = async (body: Record<string, unknown>) => await box.send(swapId, "amm/admin", body);

  // ------------------------------------------------ a block with A's deploy, live
  const hA = mineAlone(dA);
  pushHeader();
  const swapChain = await until("swap's chain at A's block", async () => { const k = (await r.hydrate(SWAP)).kernel; const t = await k.chainTip(); return t && t.height >= hA ? t : undefined; });
  check(!!swapChain, `the host chain at ${swapChain?.height} (A's deploy mined at ${hA})`);

  // ------------------------------------------------ defaults, then enable A
  await send({ fn: "defaults", args: { terms: { lpFeeBps: 30, validatorFeeBps: 5, commissionBps: 25, minLegSats: 1000 }, market: { minCommissionBps: 2 } } });
  const df = await until("the defaults", async () => { const d = await getJson(`/@${SWAP}/amm/defaults`) as { terms?: unknown } | undefined; return d?.terms ? d : undefined; });
  check(!!df, `defaults set by root: ${JSON.stringify(df)}`);
  const t1 = Date.now();
  await send({ fn: "enable", args: { tokenId: A, beef: Uint8Array.from(dA.toAtomicBEEF()) } });
  const rowA = await until("A enabled on swap", async () => (await getJson(`/@${SWAP}/amm/tokens`) as Array<Record<string, unknown>>)?.find((t) => t.tokenId === A && t.status === "enabled"));
  check(!!rowA && !("url" in rowA) && !("deploy" in rowA) && rowA.sym === "AAA", `swap: A enabled, a fact (${JSON.stringify(rowA)})`);
  check(!!rowA && rowA.iconUrl === `/@discovery/1color/${A}/icon` && !("icon" in rowA), `…its iconUrl the discovery icon route, no data-URL icon (P12; ${String(rowA?.iconUrl)})`);
  const up = await until("/@A/amm/token", async () => { const t = await get(`/@${A}/amm/token`); return t.status === 200 ? t : undefined; }, 60_000);
  check(!!up && JSON.parse(up.text).tokenId === A, `the host reacted: /@<A>/amm/token 200 ${Date.now() - t1} ms after the enable`);
  await x.exchange.idle();
  keep(x, A);
  check((await rootOf(x, A)).join() === SHARED, "A: born owned by the host's key (no claim)");
  check(JSON.stringify(JSON.parse(x.db.get(A)!.topics ?? "[]")) === JSON.stringify([tmA, lsA, ammA]), `A: routed by ${x.db.get(A)!.topics}`);
  const lt = await getJson(`/@${A}/amm/listTopicManagers`), ll = await getJson(`/@${A}/amm/listLookupServiceProviders`);
  check(!!lt && tmA in lt && !!ll && lsA in ll && ammA in ll, `A serves ${Object.keys(lt ?? {}).join(", ")} · ${Object.keys(ll ?? {}).join(", ")}`);
  const kA = (await r.hydrate(A)).kernel;
  const terms = await until("A's amm/terms", async () => { const c = await kA.call("head", "amm/terms"); return c ? await kA.store.get(c as never) as Record<string, unknown> : undefined; });
  check(!!terms && JSON.stringify(terms).includes("25") && terms.minLegSats === 1000, `A: the default terms sent as root's message, minLegSats with them (0.14.0; amm/terms ${JSON.stringify(terms)})`);
  const market = await until("A's amm/market", async () => { const c = await kA.call("head", "amm/market"); return c ? await kA.store.get(c as never) as Record<string, unknown> : undefined; });
  check(!!market, `A: the default market sent (amm/market ${JSON.stringify(market)})`);
  const lk = await fetch(`${R}/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: lsA, query: { type: "color-admission", version: 1, assetId: A, topic: tmA, outpoints: [`${dA.id("hex")}.0`] } }) });
  const lkb = await lk.json().catch(() => ({})) as { type?: string; outputs?: unknown[] };
  check(lk.status === 200 && lkb.type === "output-list" && (lkb.outputs?.length ?? 0) === 1, `bare-host POST /lookup ${lsA.slice(0, 18)}…: routed to A, color-admission answers the deploy (${lk.status} ${JSON.stringify(lkb).slice(0, 100)})`);
  const liveT = await until("tm_color_A-live", async () => { const v = await getJson(`/@${A}/amm/.live/${tmA}-live`) as unknown[] | undefined; return v?.length ? v : undefined; }, 60_000);
  check(!!liveT, `beats on tm_color_<A>-live (${liveT?.length ?? 0})`);
  const liveL = await until("ls_amm_A-live", async () => { const v = await getJson(`/@${A}/amm/.live/${ammA}-live`) as unknown[] | undefined; return v?.length ? v : undefined; }, 60_000);
  check(!!liveL, `beats on ls_amm_<A>-live (${liveL?.length ?? 0})`);

  // ------------------------------------------------ pools (0.11.0): the host's GET /@<A>/amm/pools and /amm/pools
  // Three deploy pools of A: P0 under A's own identity (beating on tm_color_<A>-live), commission 25 — listed;
  // P1 under a stranger's identity (not beating) — absent; P2 under A's identity, commission 1 < the market's
  // minimum 2 — absent. Their tokens from a transfer T of A's deploy, their sats from a mined funding F.
  const idA = x.db.get(A)!.identity!;
  check(idA === SHARED, `A's identity is the host's key (one-key host): ${idA.slice(0, 8)}…`);
  const appRec = await kA.store.get(await kA.call("head", "amm/app") as never) as unknown as { tree: never };
  const tree = await skein<typeof import("@dcasegr/skein/dist/runtime/tree.js")>("src/runtime/tree.ts");
  const stA = sk.stores.openStoreFile(sk.indexStore.storeSpec(x.db.get(A)!), { readOnly: true });
  let tpl: PoolTemplate;
  try { tpl = templateOf(new TextDecoder().decode(await tree.readFile(stA as never, appRec.tree, "src/fixtures/pool_artifact.zig"))); } finally { stA.close(); }
  const assetId = Buffer.from(dA.id("hex"), "hex").reverse();
  const hold = new P2PKH().lock(holder.toPublicKey().toHash());
  const F = new Transaction();
  F.addInput({ sourceTXID: "f1".repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  for (let i = 0; i < 3; i++) F.addOutput({ lockingScript: hold, satoshis: 50_000 });
  F.addOutput({ lockingScript: hold, satoshis: 10 });
  const hF = mineAlone(F);
  pushHeader();
  check(!!(await until("A's chain at F's block", async () => { const t = await kA.chainTip(); return t && t.height >= hF ? t : undefined; })), `F (the pools' sats) mined at ${hF}`);
  const T = new Transaction();
  T.addInput({ sourceTransaction: dA, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(holder) });
  T.addInput({ sourceTransaction: F, sourceOutputIndex: 3, unlockingScriptTemplate: new P2PKH().unlock(holder) });
  for (let i = 0; i < 3; i++) T.addOutput({ lockingScript: valueScript(assetId, 7_000_000, hold), satoshis: 1 });
  T.addOutput({ lockingScript: hold, satoshis: 8 });
  await T.sign();
  const stranger = new PrivateKey("5151", 16);
  const lps = [0, 1, 2].map(() => PrivateKey.fromRandom().toPublicKey().toString());
  const pools = [
    { identity: shared, commission: 25 },
    { identity: stranger, commission: 25 },
    { identity: shared, commission: 1 },
  ].map((p, k) => {
    const t = new Transaction();
    t.addInput({ sourceTransaction: T, sourceOutputIndex: k, unlockingScriptTemplate: new P2PKH().unlock(holder) });
    t.addInput({ sourceTransaction: F, sourceOutputIndex: k, unlockingScriptTemplate: new P2PKH().unlock(holder) });
    t.addOutput({ lockingScript: poolScript(tpl, { assetId, reserve: 7_000_000, sats: 50_001, fees: [30, 5, p.commission], lp: lps[k]!, identity: p.identity }), satoshis: 50_001 });
    return t;
  });
  for (const t of pools) await t.sign();
  const submitA = async (t: InstanceType<typeof Transaction>) => {
    const r = await fetch(`${R}/submit`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-topics": JSON.stringify([tmA]) }, body: Uint8Array.from(t.toBEEF()) });
    return { status: r.status, text: await r.text() };
  };
  const p2 = `${R}/@${A}/amm/pools`;
  const s2 = await fetch(p2, { headers: { accept: "text/event-stream" } });
  const first2 = await s2.json().catch(() => undefined) as { pools?: unknown[] } | undefined;
  check(s2.status === 200 && /application\/json/.test(s2.headers.get("content-type") ?? "") && !!first2 && Array.isArray(first2.pools) && first2.pools.length === 0, `GET /@<A>/amm/pools asked for an event stream: the plain read (0.14.0: the pools route no longer streams; ${s2.headers.get("content-type")}), no pools yet`);
  const subT = await submitA(T);
  check(subT.status === 200, `T (A's deploy split in three) submitted to ${tmA.slice(0, 18)}… (${subT.status} ${subT.text.slice(0, 120)})`);
  for (const [k, t] of pools.entries()) { const r = await submitA(t); check(r.status === 200, `pool P${k} submitted (${r.status} ${r.text.slice(0, 120)})`); }
  const listed = await until("ls_amm_A lists the three pools", async () => {
    const r = await fetch(`${R}/@${A}/amm/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: ammA, query: { tokenId: A } }) });
    const j = await r.json().catch(() => ({})) as { result?: unknown[] };
    return (j.result?.length ?? 0) === 3 ? j.result : undefined;
  });
  check(!!listed, `ls_amm_<A> {tokenId} lists P0, P1 and P2 (${listed?.length ?? 0})`);
  const p0 = `${pools[0]!.id("hex")}_0`;
  const g2 = await fetch(p2);
  const b2 = await g2.json().catch(() => ({})) as { market?: { minCommissionBps?: unknown; commissionPkh?: unknown }; validators?: Array<{ identity?: string; peerId?: string }>; pools?: Array<Record<string, unknown>> };
  check(g2.status === 200 && g2.headers.get("cache-control") === "public, max-age=5", `GET /@<A>/amm/pools: 200, cache-control ${g2.headers.get("cache-control")}`);
  check(b2.pools?.length === 1 && b2.pools[0]!.outpoint === p0, `…only P0: P1 (validator not beating) and P2 (commission 1 < the market's 2) absent (${JSON.stringify(b2.pools?.map((p) => p.outpoint))})`);
  const row0 = b2.pools?.[0];
  check(!!row0 && row0.validatorIdentityKey === SHARED && row0.validatorPeerId === (liveT?.[0] as { from?: string } | undefined)?.from && row0.lpPubKey === lps[0] && row0.commissionBps === 25, `…P0's row: validator ${String(row0?.validatorIdentityKey).slice(0, 8)}…, peer ${String(row0?.validatorPeerId).slice(0, 12)}…, lpPubKey ${row0?.lpPubKey === lps[0] ? "its LP key" : String(row0?.lpPubKey)} (${JSON.stringify(row0)})`);
  check(!!row0 && row0.poolId === p0 && row0.swaps === 0, `…P0's pool id is its deploy outpoint, swaps 0 (0.14.0; poolId ${String(row0?.poolId)}, swaps ${String(row0?.swaps)})`);
  check(b2.market?.minCommissionBps === 2 && typeof b2.market.commissionPkh === "string", `…the market: ${JSON.stringify(b2.market)}`);
  const vs = (b2.validators ?? []) as Array<{ identity?: string; peerId?: string; minLegSats?: number }>;
  check(vs.some((v) => v.identity === SHARED && v.peerId === (liveT?.[0] as { from?: string } | undefined)?.from) && !vs.some((v) => v.identity === stranger.toPublicKey().toString()), `…validators: the beating one (the host key, its peer ID), not the stranger (${JSON.stringify(vs.map((v) => `${String(v.identity).slice(0, 8)}…/${String(v.peerId).slice(0, 12)}…`))})`);
  // The beat carries the terms once the instance re-declares its beacons with them (a beat on the host's timer).
  const vMin = await until("A's validator with its minLegSats", async () => ((await getJson(`/@${A}/amm/pools`) as { validators?: Array<{ identity?: string; minLegSats?: number }> } | undefined)?.validators ?? []).find((v) => v.identity === SHARED && v.minLegSats === 1000), 180_000);
  check(!!vMin, `…the beating validator's minLegSats from its beat's terms (0.14.0): ${JSON.stringify(vMin)}`);
  const g1 = await fetch(`${R}/amm/pools`);
  const b1 = await g1.json().catch(() => undefined) as Array<Record<string, unknown>> | undefined;
  check(g1.status === 200 && b1?.length === 1 && b1[0]!.tokenId === A && b1[0]!.outpoint === p0 && g1.headers.get("cache-control") === "public, max-age=5", `GET /amm/pools (the bare host: swap): every enabled token's, each row with its tokenId (${JSON.stringify(b1?.map((p) => `${String(p.tokenId).slice(0, 8)}… ${String(p.outpoint).slice(0, 8)}…`))})`);
  const g1s = await fetch(`${R}/amm/pools`, { headers: { accept: "text/event-stream" } });
  check(g1s.status === 200 && /application\/json/.test(g1s.headers.get("content-type") ?? "") && Array.isArray(await g1s.json().catch(() => undefined)), `GET /amm/pools asked for an event stream: the plain read (0.13.0, D7: the host-wide stream is gone; ${g1s.headers.get("content-type")})`);

  // ------------------------------------------------ stats over the listed pools (0.13.1): P1 (validator not beating)
  // and P2 (commission below the market's minimum) are in the instance's own /stats row, not in the host's answer.
  const ownA = await (x!.pools as unknown as { instanceStats(h: string): Promise<Record<string, unknown>> }).instanceStats(A);
  check(ownA.pools === 3 && ownA.tvlSats === 3 * 50_001 && ownA.lastTradeAt === null, `A's instance /stats, unfiltered: 3 pools, tvlSats ${String(ownA.tvlSats)} (${JSON.stringify(ownA)})`);
  const stA0 = await getJson(`/@${A}/amm/stats`) as Record<string, unknown> | undefined;
  const midA0 = priceOf([poolState(row0 as Record<string, unknown>)])?.mid;
  const pA0 = stA0?.price as { sats?: number; tokens?: number } | null | undefined;
  check(stA0?.pools === 1 && stA0.tvlSats === 50_001 && stA0.tvlTokens === 7_000_000 && !!midA0 && pA0?.sats === Number(midA0.sats) && pA0?.tokens === Number(midA0.tokens) && !!stA0.buyPrice && !!stA0.sellPrice && stA0.lastTradePrice === null && stA0.change1h === null && stA0.change24h === null,
    `GET /@<A>/amm/stats (the host's): only P0 counted — pools 1, tvl 50001 sats / 7000000; price = priceOf([P0]).mid, buy and sell set; no trade, no pools an hour ago: lastTradePrice and the changes null (${JSON.stringify(stA0)})`);
  // mergeStats and changeBps alone: the price over the LISTED pools; none listed, no price; the change from a past mid.
  const fp = (sats: number, tokens: number) => ({ poolId: "x_0", outpoint: "x_0", bsvReserve: sats, tokenReserve: tokens, liquidityFeeBps: 30, validationFeeBps: 5, commissionBps: 25, validatorIdentityKey: SHARED, validatorPeerId: "p", swaps: 0 });
  const own = { tokenId: A, lastTradePrice: null, lastTradeAt: null, tvlSats: 1900, tvlTokens: 12, pools: 3 };
  const two = [fp(3_000_000, 50_000_000), fp(7_000_000, 60_000_000)];
  const m1 = mergeStats(own, two, null, null);
  const want1 = priceOf(two.map((p) => poolState(p)))!;
  const m3 = mergeStats(own, [], { sats: 1n, tokens: 1n }, null);
  const then = { sats: want1.mid.sats * 9n, tokens: want1.mid.tokens * 10n };
  const m4 = mergeStats(own, two, then, then);
  check(JSON.stringify(m1.price, (_k, v) => typeof v === "bigint" ? v.toString() : v) === JSON.stringify({ sats: want1.mid.sats.toString(), tokens: want1.mid.tokens.toString() }) && m1.tvlSats === 10_000_000n && m1.tvlTokens === 110_000_000n && m1.pools === 2 && m1.change1h === null
    && m3.price === null && m3.buyPrice === null && m3.sellPrice === null && m3.change1h === null && m3.pools === 0 && m3.tvlSats === 0n && m4.change1h === 1111n && m4.change24h === 1111n && changeBps({ sats: 2n, tokens: 1n }, { sats: 1n, tokens: 1n }) === -5000n,
    `mergeStats: price = priceOf(listed).mid; none listed → null; the change from a past mid in bps, truncated (${String(m4.change1h)}); changeBps 2→1 = ${String(changeBps({ sats: 2n, tokens: 1n }, { sats: 1n, tokens: 1n }))}`);
  const allA0 = (await getJson("/amm/stats") as Array<Record<string, unknown>> | undefined)?.find((y) => y.tokenId === A);
  check(!!allA0 && allA0.pools === 1 && allA0.tvlSats === 50_001, `GET /amm/stats: A's row the same (pools ${String(allA0?.pools)}, tvlSats ${String(allA0?.tvlSats)})`);

  // ------------------------------------------------ history (0.13.0, D1–D7): B from the token app's fixtures
  const fixturesZig = await (async () => { const st = sk.stores.openStoreFile(sk.indexStore.storeSpec(x!.db.get(A)!), { readOnly: true }); try { return new TextDecoder().decode(await tree.readFile(st as never, appRec.tree, "src/fixtures/vectors.zig")); } finally { st.close(); } })();
  const fx = (name: string) => Transaction.fromHex(new RegExp(`pub const ${name} = "([0-9a-f]+)"`).exec(fixturesZig)![1]!);
  const fxLp = /pub const lp = "([0-9a-f]+)"/.exec(fixturesZig)![1]!;
  const order = ["fund", "token_deploy", "pool_deploy", "swap_bsv_in", "swap_tokens_in", "close", "swap_token_change", "close_after_token_change"];
  const ftx = new Map(order.map((n) => [n, fx(n)]));
  const byId = new Map([...ftx.values()].map((t) => [t.id("hex"), t]));
  let topH = 0;
  for (const n of order) {
    const t = ftx.get(n)!;
    let root = false;
    for (const i of t.inputs) { const src = byId.get(i.sourceTXID!); if (src) i.sourceTransaction = src; else root = true; }
    if (root) { topH = mineAlone(t); pushHeader(); }
  }
  check(!!(await until("A's chain at the fixtures' roots", async () => { const t = await kA.chainTip(); return t && t.height >= topH ? t : undefined; })), `the fixtures' roots (fund, token_deploy) mined, to ${topH}`);
  const B = `${ftx.get("token_deploy")!.id("hex")}_0`;
  const tmB = `tm_color_${B}`;
  await send({ fn: "enable", args: { tokenId: B, beef: Uint8Array.from(ftx.get("token_deploy")!.toAtomicBEEF()) } });
  check(!!(await until("/@B/amm/token", async () => (await get(`/@${B}/amm/token`)).status === 200 ? true : undefined, 60_000)), `B (the fixtures' token) enabled: /@<B>/amm/token 200`);
  await x.exchange.idle();
  keep(x, B);
  const beatsB = await until("B's validator beating", async () => { const v = await getJson(`/@${B}/amm/pools`) as { validators?: Array<{ identity?: string }> } | undefined; return v?.validators?.some((y) => y.identity === SHARED) ? v : undefined; }, 60_000);
  check(!!beatsB, "B's pools route names this host as a beating validator (the fixtures' identity)");
  // 0.14.0: the pool event feeds — B's and the origin's — open before B's pool history begins; A's sees none of it.
  const fB = poolFeed(`${R}/@${B}/amm/events`), fAll = poolFeed(`${R}/amm/events`), fA = poolFeed(`${R}/@${A}/amm/events`);
  check(!!(await until("the feeds connected", () => fB.status() && fAll.status() && fA.status() ? true : undefined, 15_000)) && fB.status() === 200 && /text\/event-stream/.test(fB.type()) && fAll.status() === 200 && /text\/event-stream/.test(fAll.type()), `GET /@<B>/amm/events and /amm/events: event streams (${fB.status()} ${fB.type()}, ${fAll.status()} ${fAll.type()})`);
  await sleep(1000);
  check(fB.got.length === 0 && fB.other.length === 0 && fAll.got.length === 0 && fAll.other.length === 0, "…nothing sent on connect (no replay)");
  const submitB = async (n: string) => {
    const r = await fetch(`${R}/submit`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-topics": JSON.stringify([tmB]) }, body: Uint8Array.from(ftx.get(n)!.toBEEF()) });
    return { status: r.status, text: await r.text() };
  };
  const opOf = (n: string) => `${ftx.get(n)!.id("hex")}_0`;
  const poolB = opOf("pool_deploy");
  const expectEvent = async (n: string, kind: string, k: number) => {
    const sub = await submitB(n);
    const e = await until(`B's pool event ${kind} (${n})`, () => fB.got.length > k && fAll.got.length > k ? fB.got[k] : undefined, 30_000);
    const same = !!e && JSON.stringify(e) === JSON.stringify(fAll.got[k]);
    check(sub.status === 200 && e?.kind === kind && e.tokenId === B && e.poolId === poolB && e.txid === ftx.get(n)!.id("hex") && same, `${n} submitted to ${tmB.slice(0, 18)}… (${sub.status} ${sub.text.slice(0, 80)}): both feeds sent event pool {tokenId B, kind ${kind}, poolId the deploy's outpoint, txid} (${JSON.stringify(e)?.slice(0, 200)})`);
    return e;
  };
  const eDeploy = await expectEvent("pool_deploy", "deploy", 0);
  check(eDeploy?.outpoint === poolB && eDeploy.swaps === 0 && typeof eDeploy.at === "number", `…deploy: outpoint ${String(eDeploy?.outpoint).slice(0, 8)}…, swaps 0, at`);
  const eBuy = await expectEvent("swap_bsv_in", "swap", 1);
  check(eBuy?.outpoint === opOf("swap_bsv_in") && eBuy.swaps === 1 && eBuy.side === "buy" && eBuy.amountIn === 20000 && eBuy.lpPubKey === fxLp && typeof eBuy.payoutPkh === "string", `…swap: the continuation's outpoint, swaps 1, side buy, amountIn ${String(eBuy?.amountIn)}, its payoutPkh`);
  const eSell = await expectEvent("swap_tokens_in", "swap", 2);
  check(eSell?.swaps === 2 && eSell.side === "sell" && eSell.amountIn === 50000, `…the token-in swap: a sell, swaps 2 (${JSON.stringify(eSell)?.slice(0, 120)})`);
  const eClose = await expectEvent("close", "close", 3);
  check(!!eClose && eClose.poolId === poolB, "…the LP's Close: kind close on the pool's id");
  check(fA.got.length === 0, `…A's feed sent none of B's (${fA.got.length})`);
  check(fB.got.length === 4 && fAll.got.length === 4, `…four events each, nothing else (${fB.got.length}, ${fAll.got.length})`);
  await Promise.all([fB.close(), fAll.close(), fA.close()]);
  // The token-change lineage (swap_token_change competes with swap_tokens_in): on a second host, below.

  // the pool history reads at the times the events carry
  const [atD, atBuy, atSell, atClose] = [eDeploy, eBuy, eSell, eClose].map((e) => Number(e?.at));
  const at = async (t: number) => await getJson(`/@${B}/amm/pools/at?t=${t}`) as Array<Record<string, unknown>> | undefined;
  const before = await at(atD - 1), afterBuy = await at(atBuy), afterClose = await at(atClose);
  check(before?.length === 0 && afterBuy?.length === 1 && afterBuy[0]!.poolId === poolB && afterBuy[0]!.outpoint === opOf("swap_bsv_in") && afterBuy[0]!.swaps === 1 && afterClose?.length === 0, `GET /@<B>/amm/pools/at: none before the deploy, the bsv-in swap's state at its time, none at the close (${JSON.stringify(afterBuy)?.slice(0, 160)})`);
  const hist = await getJson(`/@${B}/amm/pools/history?from=0`) as { events?: Array<Record<string, unknown>>; next?: unknown } | undefined;
  check(hist?.events?.map((e) => e.kind).join() === "deploy,swap,swap,close" && hist.next === null, `GET /@<B>/amm/pools/history: deploy, swap, swap, close, next null (${hist?.events?.map((e) => e.kind).join()})`);
  const page1 = await getJson(`/@${B}/amm/pools/history?from=0&limit=1`) as { events?: unknown[]; next?: string } | undefined;
  const page2 = page1?.next ? await getJson(`/@${B}/amm/pools/history?from=0&limit=3&after=${page1.next}`) as { events?: Array<Record<string, unknown>>; next?: unknown } | undefined : undefined;
  check(page1?.events?.length === 1 && typeof page1.next === "string" && page2?.events?.map((e) => e.kind).join() === "swap,swap,close" && page2.next === null, "…?limit=1 then ?after=<next>: the rest of the window, once each");

  const tr = await fetch(`${R}/@${B}/amm/trades`);
  const trj = await tr.json().catch(() => ({})) as { trades?: Array<Record<string, unknown>>; next?: unknown };
  check(tr.status === 200 && tr.headers.get("cache-control") === "public, max-age=5" && trj.trades?.length === 2 && trj.trades[0]!.side === "sell" && trj.trades[1]!.side === "buy" && trj.next === null && trj.trades.every((t) => t.poolId === poolB), `GET /@<B>/amm/trades: two rows, newest first (${trj.trades?.map((t) => t.side).join(", ")}), each with the pool id, next null`);
  check(!!trj.trades && trj.trades.every((t) => "height" in t && t.height === null && typeof t.at === "number" && typeof t.feeLp === "number"), "…each row with `at`, the fees, and `height` null (unmined)");
  const one = await getJson(`/@${B}/amm/trades?txid=${ftx.get("swap_bsv_in")!.id("hex")}`) as Record<string, unknown> | undefined;
  check(one?.side === "buy" && (await get(`/@${B}/amm/trades?txid=${ftx.get("pool_deploy")!.id("hex")}`)).status === 404, "…?txid= the one row; a deploy's txid 404");
  { const pg = await getJson(`/@${B}/amm/trades?pool=${poolB}&limit=1`) as { trades?: unknown[]; next?: unknown } | undefined; check(pg?.trades?.length === 1 && typeof pg.next === "string", "…?pool= the pool's rows, a full page carries `next`"); }
  const now = Date.now();
  const win = `tf=1m&from=${now - 3_600_000}&to=${now + 60_000}`;
  const cs = await getJson(`/@${B}/amm/candles?${win}`) as Array<{ t?: number; n?: number; o?: { sats?: number; tokens?: number } }> | undefined;
  check(!!cs && cs.length >= 1 && cs.reduce((k, c) => k + (c.n ?? 0), 0) === 2 && typeof cs[0]!.o?.sats === "number", `GET /@<B>/amm/candles?tf=1m (the fills, the instance's): ${cs?.length} non-empty bucket(s), 2 trades (${JSON.stringify(cs)?.slice(0, 160)})`);
  check(JSON.stringify(await getJson(`/@${B}/amm/candles?series=fill&${win}`)) === JSON.stringify(cs), "…?series=fill: the same answer");
  check((await get(`/@${B}/amm/candles?tf=1m&from=0&to=${now}`)).status === 400, "…a window over 5000 buckets: 400");
  const mk = await getJson(`/@${B}/amm/candles?series=market&${win}`) as Array<Record<string, unknown>> | undefined;
  const mkWant = marketCandles([], hist?.events ?? [], 60_000);
  const firstMid = priceOf([poolState(eDeploy!)])!.mid;
  const big = (v: unknown) => BigInt(v as number);
  check(!!mk && mk.length >= 1 && mk.reduce((k, c) => k + Number(c.n), 0) === 2 && mk.length === mkWant.length
    && big((mk[0]!.o as { sats: number }).sats) * firstMid.tokens === firstMid.sats * big((mk[0]!.o as { tokens: number }).tokens)
    && mk.reduce((k, c) => k + Number(c.volumeSats), 0) === Number(mkWant.reduce((k, c) => k + c.volumeSats, 0n)),
    `GET /@<B>/amm/candles?series=market (the host's): ${mk?.length} bucket(s), n 2, o = the price after the deploy (priceOf([deploy]).mid), the swaps' volumes (${JSON.stringify(mk)?.slice(0, 200)})`);
  check((await get(`/@${B}/amm/candles?series=market&tf=2m&from=0&to=1`)).status === 400 && (await get(`/@${B}/amm/candles?series=market&tf=1m&from=0&to=${now}`)).status === 400, "…market: a bad tf 400; a window over 5000 buckets 400");
  const stB = await getJson(`/@${B}/amm/stats`) as Record<string, unknown> | undefined;
  check(stB?.tokenId === B && stB.buys24h === 1 && stB.sells24h === 1 && typeof stB.lastTradeAt === "number" && (stB.lastTradePrice as { sats?: number } | null)?.sats !== undefined && stB.pools === 0 && stB.price === null && stB.buyPrice === null && stB.sellPrice === null && stB.change24h === null, `GET /@<B>/amm/stats: closed, so no price; the last fill as lastTradePrice (${JSON.stringify(stB)})`);
  const stAll = await getJson("/amm/stats") as Array<{ tokenId?: string }> | undefined;
  check(!!stAll && stAll.some((y) => y.tokenId === A) && stAll.some((y) => y.tokenId === B), `GET /amm/stats: every enabled token's (${stAll?.map((y) => String(y.tokenId).slice(0, 8)).join(", ")})`);
  const stIds = await getJson(`/amm/stats?ids=${B}`) as Array<{ tokenId?: string }> | undefined;
  check(stIds?.length === 1 && stIds[0]!.tokenId === B, "…?ids= those tokens only");
  const posAll = await getJson(`/amm/positions?pool=${poolB}`) as Array<{ tokenId?: string; poolId?: string; status?: string; swaps?: number }> | undefined;
  const posB = posAll?.find((y) => y.tokenId === B);
  check(!!posAll && posAll.length === 2 && posB?.poolId === poolB && posB.status === "closed" && posB.swaps === 2 && (await get("/amm/positions")).status === 400, `GET /amm/positions?pool=: every enabled token's rows with tokenId (B ${JSON.stringify(posB)}); no pool 400`);
  const deployOp = `${ftx.get("pool_deploy")!.id("hex")}.0`, closeOp = `${ftx.get("close")!.id("hex")}.0`;
  const sp = await getJson(`/amm/spends?outpoint=${deployOp},${closeOp}`) as Array<{ outpoint?: string; tokenId?: string; spentBy?: string }> | undefined;
  check(sp?.length === 2 && sp[0]!.outpoint === deployOp && sp[0]!.tokenId === B && sp[0]!.spentBy === ftx.get("swap_bsv_in")!.id("hex") && sp[1]!.outpoint === closeOp && sp[1]!.spentBy === undefined && sp[1]!.tokenId === undefined && (await get("/amm/spends")).status === 400, `GET /amm/spends?outpoint=: the deploy's spender with its token, the close's output unspent; none 400 (${JSON.stringify(sp)})`);
  const hB = await getJson(`/@${B}/amm/color/${B}/holders`) as { count?: number; rows?: Array<{ address?: string; balance?: number }> } | undefined;
  check(!!hB && (hB.count ?? 0) >= 1 && hB.rows?.length === hB.count && hB.rows!.every((y, i) => i === 0 || (y.balance ?? 0) <= (hB.rows![i - 1]!.balance ?? 0)), `GET /@<B>/amm/color/<B>/holders: ${JSON.stringify(hB)?.slice(0, 200)}`);

  // ------------------------------------------------ a swap WITH token change (0.14.0): B's other lineage on a second host
  // (the fixtures' swap_token_change spends swap_bsv_in:0 as swap_tokens_in does, so one overlay holds one of them):
  // deploy → sats-in swap → the tokens-in swap with 10,000 tokens of token change → close_after_token_change.
  {
    const home2 = mkdtempSync(join(tmpdir(), "ox-accept-2-"));
    writeFileSync(join(home2, "key"), `${shared.toHex()}\n`, { mode: 0o600 });
    const port2 = await freePort(), hostPort2 = await freePort(), p2pPort2 = await freePort();
    writeFileSync(join(home2, "host.env"), [
      `SKEIN_KEY_FILE=${join(home2, "key")}`,
      ...(ROCKS ? [`SKEIN_STORE_ROCKSDB=${join(home2, "store-rocksdb")}`] : FILE ? [] : [`SKEIN_STORE_SQLITE=${join(home2, "store.sqlite")}`]),
      `SKEIN_ROOT_INSTANCE=${SWAP}`, "SKEIN_NETWORK=regtest", `SKEIN_ROUTER_PORT=${port2}`, `SKEIN_HOST_PORT=${hostPort2}`, `SKEIN_HEADERS_URL=${feedUrl}`,
      `SKEIN_ARC_URL=${arcade.url}`, "SKEIN_ARC_TOKEN=t", `SKEIN_ARC_EVENTS_URL=${arcade.eventsUrl}`, `SKEIN_LIBP2P_LISTEN=/ip4/127.0.0.1/tcp/${p2pPort2}`,
      ...(kernel ? [`SKEIN_KERNEL_BIN=${kernel}`] : []), "",
    ].join("\n"));
    const lines2: string[] = [];
    const env2: Env = { vars: { HOME: process.env.HOME, PATH: process.env.PATH, SKEIN_HOME: home2 }, out: (l) => { lines2.push(l); if (process.env.VERBOSE) process.stdout.write(`  2| ${l}\n`); }, err: (l) => { lines2.push(`ERR ${l}`); process.stdout.write(`  2! ${l}\n`); } };
    const R2 = `http://127.0.0.1:${port2}`;
    const get2 = async (path: string) => { const r = await fetch(`${R2}${path}`); return r.status === 200 ? await r.json() as unknown : undefined; };
    let y: Running | undefined;
    try {
      const fr2 = await firstRun(sk, env2);
      check(!fr2.failed, `second host: the first run (${fr2.made.join("; ")})`);
      if (ROCKS) await sleep(1500);
      y = await startExchange(sk, settings(sk, env2));
      await y.exchange.idle();
      await until("the second host's chain at the fixtures' roots", async () => { const t = await (await y!.host.router.hydrate(SWAP)).kernel.chainTip(); return t && t.height >= topH ? t : undefined; });
      await y.exchange.rootMessage(SWAP, "amm/admin", { fn: "enable", args: { tokenId: B, beef: Uint8Array.from(ftx.get("token_deploy")!.toAtomicBEEF()) } });
      check(!!(await until("/@B/amm/token on the second host", async () => (await fetch(`${R2}/@${B}/amm/token`)).status === 200 ? true : undefined, 60_000)), "second host: B enabled by root");
      await y.exchange.idle();
      check(!!(await until("B's validator beating on the second host", async () => ((await get2(`/@${B}/amm/pools`)) as { validators?: Array<{ identity?: string }> } | undefined)?.validators?.some((v) => v.identity === SHARED) ? true : undefined, 60_000)), "…its validator beating");
      const feed2 = poolFeed(`${R2}/@${B}/amm/events`);
      await until("the second host's feed", () => feed2.status() || undefined, 15_000);
      const submit2 = async (n: string) => (await fetch(`${R2}/submit`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-topics": JSON.stringify([tmB]) }, body: Uint8Array.from(ftx.get(n)!.toBEEF()) })).status;
      const kinds: string[] = [];
      for (const [n, kind] of [["pool_deploy", "deploy"], ["swap_bsv_in", "swap"], ["swap_token_change", "swap"], ["close_after_token_change", "close"]] as const) {
        const st = await submit2(n);
        const e = await until(`second host: ${n}'s event`, () => feed2.got.find((y) => y.txid === ftx.get(n)!.id("hex")), 30_000);
        check(st === 200 && e?.kind === kind && e.poolId === poolB, `second host: ${n} submitted (${st}): event pool {kind ${String(e?.kind)}, poolId the deploy's}`);
        if (e) kinds.push(String(e.kind));
      }
      const tcTx = ftx.get("swap_token_change")!;
      const tcAmount = Number(/pub const swap_token_change_amount_in = (\d+);/.exec(fixturesZig)?.[1]);
      const tcChange = Number(/pub const swap_token_change_tokens = (\d+);/.exec(fixturesZig)?.[1]);
      const eTc = feed2.got.find((y) => y.txid === tcTx.id("hex"));
      check(eTc?.side === "sell" && eTc.amountIn === tcAmount && eTc.swaps === 2 && eTc.outpoint === `${tcTx.id("hex")}_0` && tcTx.outputs.length === 7, `…the swap with token change: a sell of ${String(eTc?.amountIn)} (the vector's ${tcAmount}), swaps 2, its transaction carries the token change output (${tcChange} tokens back; ${tcTx.outputs.length} outputs)`);
      const trTc = await get2(`/@${B}/amm/trades?txid=${tcTx.id("hex")}`) as Record<string, unknown> | undefined;
      check(trTc?.side === "sell" && trTc.amountIn === tcAmount && trTc.poolId === poolB, `…its trade row: amountIn ${String(trTc?.amountIn)}, poolId the deploy's`);
      const atTc = await get2(`/@${B}/amm/pools/at?t=${Number(eTc?.at)}`) as Array<Record<string, unknown>> | undefined;
      const hist2 = await get2(`/@${B}/amm/pools/history?from=0`) as { events?: Array<Record<string, unknown>> } | undefined;
      check(atTc?.length === 1 && atTc[0]!.outpoint === `${tcTx.id("hex")}_0` && hist2?.events?.map((e) => e.kind).join() === "deploy,swap,swap,close" && kinds.join() === "deploy,swap,swap,close", `…/pools/at the token-change swap's state at its time; /pools/history deploy, swap, swap, close (${hist2?.events?.map((e) => e.kind).join()})`);
      const sp2 = await get2(`/amm/spends?outpoint=${ftx.get("swap_bsv_in")!.id("hex")}.0`) as Array<{ spentBy?: string }> | undefined;
      check(sp2?.[0]?.spentBy === tcTx.id("hex"), `…/amm/spends: swap_bsv_in:0 spent by the token-change swap here (${String(sp2?.[0]?.spentBy).slice(0, 8)}…)`);
      await feed2.close();
    } finally {
      await y?.stop().catch(() => {});
      if (ROCKS) await sleep(1500);
      if (!process.env.KEEP) rmSync(home2, { recursive: true, force: true });
    }
  }

  // ------------------------------------------------ one swap in flight per pool (0.16.0; skein-amm 0.43.0, D3): B on hosts of their own
  // Two, then three, swaps on ONE pool output, relayed at once through this host's own relay (`/call`
  // amm.swap.submit, the validator this node: in-VM) before either is admitted: the validator signs one; the others
  // wait for it to settle and are answered pool_spent with the new state; the pools route lists the new outpoint, the
  // trade row exists. The swaps are built from the fixtures (swap_bsv_in's outputs and call), each funded by its own
  // output of one funding transaction (fund:1, the fixtures' taker key(0x1e)) and its preimage computed here. Each
  // race on a host of its own (the fixtures give one pool output to race on).
  //
  // 0.17.0 (skein-amm 0.44.0, skein 0.3.0: the relay's call is the host's `call` intention): `cross` puts the relay on a
  // host of its OWN (another key, bootstrapped to the validator's node): the swaps reach the validator as libp2p calls
  // its host carries — one request frame, one answer frame, the validator's host writing a waiting frame's answer when
  // its thread rests (D4). Then the validator's host is stopped and one more swap relayed: the call fails at once
  // (`failed`, `unreachable`, the host's text), and the page's one re-ask of the same swap is relayed again and fails
  // the same way.
  const raceHost = async (n: number, cross = false) => {
    const home3 = mkdtempSync(join(tmpdir(), `ox-accept-race${n}-`));
    writeFileSync(join(home3, "key"), `${shared.toHex()}\n`, { mode: 0o600 });
    const port3 = await freePort(), hostPort3 = await freePort(), p2pPort3 = await freePort();
    writeFileSync(join(home3, "host.env"), [
      `SKEIN_KEY_FILE=${join(home3, "key")}`,
      ...(ROCKS ? [`SKEIN_STORE_ROCKSDB=${join(home3, "store-rocksdb")}`] : FILE ? [] : [`SKEIN_STORE_SQLITE=${join(home3, "store.sqlite")}`]),
      `SKEIN_ROOT_INSTANCE=${SWAP}`, "SKEIN_NETWORK=regtest", `SKEIN_ROUTER_PORT=${port3}`, `SKEIN_HOST_PORT=${hostPort3}`, `SKEIN_HEADERS_URL=${feedUrl}`,
      `SKEIN_ARC_URL=${arcade.url}`, "SKEIN_ARC_TOKEN=t", `SKEIN_ARC_EVENTS_URL=${arcade.eventsUrl}`, `SKEIN_LIBP2P_LISTEN=/ip4/127.0.0.1/tcp/${p2pPort3}`,
      ...(kernel ? [`SKEIN_KERNEL_BIN=${kernel}`] : []), "",
    ].join("\n"));
    const env3: Env = { vars: { HOME: process.env.HOME, PATH: process.env.PATH, SKEIN_HOME: home3 }, out: (l) => { if (process.env.VERBOSE) process.stdout.write(`  3| ${l}\n`); }, err: (l) => { process.stdout.write(`  3! ${l}\n`); } };
    const R3 = `http://127.0.0.1:${port3}`;
    const get3 = async (path: string) => { const r = await fetch(`${R3}${path}`); return r.status === 200 ? await r.json() as unknown : undefined; };
    let z: Running | undefined;
    let zr: Running | undefined;
    const homeR = cross ? mkdtempSync(join(tmpdir(), `ox-accept-relay${n}-`)) : undefined;
    try {
      const fr3 = await firstRun(sk, env3);
      check(!fr3.failed, `race host (${n}): the first run (${fr3.made.join("; ")})`);
      if (ROCKS) await sleep(1500);
      z = await startExchange(sk, settings(sk, env3));
      await z.exchange.idle();
      await until("the race host's chain at the fixtures' roots", async () => { const t = await (await z!.host.router.hydrate(SWAP)).kernel.chainTip(); return t && t.height >= topH ? t : undefined; });
      // Terms first (the validator signs nothing without them), then B.
      await z.exchange.rootMessage(SWAP, "amm/admin", { fn: "defaults", args: { terms: { lpFeeBps: 30, validatorFeeBps: 5, commissionBps: 25 } } });
      await until("the race host's defaults", async () => ((await get3(`/@${SWAP}/amm/defaults`)) as { terms?: unknown } | undefined)?.terms ? true : undefined);
      await z.exchange.rootMessage(SWAP, "amm/admin", { fn: "enable", args: { tokenId: B, beef: Uint8Array.from(ftx.get("token_deploy")!.toAtomicBEEF()) } });
      check(!!(await until("/@B/amm/token on the race host", async () => (await fetch(`${R3}/@${B}/amm/token`)).status === 200 ? true : undefined, 60_000)), "race host: terms set, B enabled by root");
      await z.exchange.idle();
      const st3 = (await fetch(`${R3}/submit`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-topics": JSON.stringify([tmB]) }, body: Uint8Array.from(ftx.get("pool_deploy")!.toBEEF()) })).status;
      type PoolsB = { market?: { commissionPkh?: string }; validators?: Array<{ identity?: string; peerId?: string }>; pools?: Array<{ outpoint?: string; poolId?: string }> };
      const listed = await until("B's pool listed on the race host", async () => { const v = await get3(`/@${B}/amm/pools`) as PoolsB | undefined; return v?.pools?.some((q) => q.poolId === poolB) && v.validators?.some((q) => q.identity === SHARED && q.peerId) ? v : undefined; }, 60_000);
      check(st3 === 200 && !!listed, `race host: B's pool deployed (${st3}) and listed under this host's beating validator`);
      const peerId = listed?.validators?.find((q) => q.identity === SHARED)?.peerId ?? "";
      // The relay's host (cross): another key, its node bootstrapped to the validator's; B enabled there, market only.
      let RR = R3;
      let relayCommission = listed?.market?.commissionPkh ?? "";
      if (cross && homeR) {
        const relayKey = new PrivateKey("6e".repeat(32), 16);
        writeFileSync(join(homeR, "key"), `${relayKey.toHex()}\n`, { mode: 0o600 });
        const portR = await freePort(), hostPortR = await freePort(), p2pPortR = await freePort();
        writeFileSync(join(homeR, "host.env"), [
          `SKEIN_KEY_FILE=${join(homeR, "key")}`,
          ...(ROCKS ? [`SKEIN_STORE_ROCKSDB=${join(homeR, "store-rocksdb")}`] : FILE ? [] : [`SKEIN_STORE_SQLITE=${join(homeR, "store.sqlite")}`]),
          `SKEIN_ROOT_INSTANCE=${SWAP}`, "SKEIN_NETWORK=regtest", `SKEIN_ROUTER_PORT=${portR}`, `SKEIN_HOST_PORT=${hostPortR}`, `SKEIN_HEADERS_URL=${feedUrl}`,
          `SKEIN_ARC_URL=${arcade.url}`, "SKEIN_ARC_TOKEN=t", `SKEIN_ARC_EVENTS_URL=${arcade.eventsUrl}`, `SKEIN_LIBP2P_LISTEN=/ip4/127.0.0.1/tcp/${p2pPortR}`,
          `SKEIN_LIBP2P_BOOTSTRAP=/ip4/127.0.0.1/tcp/${p2pPort3}/p2p/${peerId}`,
          ...(kernel ? [`SKEIN_KERNEL_BIN=${kernel}`] : []), "",
        ].join("\n"));
        const envR: Env = { vars: { HOME: process.env.HOME, PATH: process.env.PATH, SKEIN_HOME: homeR }, out: (l) => { if (process.env.VERBOSE) process.stdout.write(`  r| ${l}\n`); }, err: (l) => { process.stdout.write(`  r! ${l}\n`); } };
        RR = `http://127.0.0.1:${portR}`;
        const frR = await firstRun(sk, envR);
        check(!frR.failed, `cross: the relay's host, another key, bootstrapped to the validator's node (${frR.made.join("; ")})`);
        if (ROCKS) await sleep(1500);
        zr = await startExchange(sk, settings(sk, envR));
        await zr.exchange.idle();
        await until("the relay host's chain at the fixtures' roots", async () => { const t = await (await zr!.host.router.hydrate(SWAP)).kernel.chainTip(); return t && t.height >= topH ? t : undefined; });
        await zr.exchange.rootMessage(SWAP, "amm/admin", { fn: "enable", args: { tokenId: B, beef: Uint8Array.from(ftx.get("token_deploy")!.toAtomicBEEF()) } });
        check(!!(await until("/@B/amm/token on the relay host", async () => (await fetch(`${RR}/@${B}/amm/token`)).status === 200 ? true : undefined, 60_000)), "cross: B enabled on the relay's host (no terms: market only, it validates nothing)");
        await zr.exchange.idle();
        const tm = await until("the relay's commission key", async () => { const r = await fetch(`${RR}/@${B}/amm/pools`); const v = r.status === 200 ? await r.json() as PoolsB : undefined; return v?.market?.commissionPkh; }, 30_000);
        relayCommission = tm ?? "";
        check(/^[0-9a-f]{40}$/.test(relayCommission) && relayCommission !== (listed?.market?.commissionPkh ?? ""), `cross: the relay's own commission pkh (${relayCommission.slice(0, 8)}…), not the validator host's`);
      }

      const fund = ftx.get("fund")!, pd = ftx.get("pool_deploy")!, base = ftx.get("swap_bsv_in")!;
      const taker = new PrivateKey("1e".repeat(32), 16);
      const takerLock = new P2PKH().lock(taker.toPublicKey().toHash());
      check(fund.outputs[1]!.lockingScript.toHex() === takerLock.toHex(), "the fixtures' fund:1 pays the taker key(0x1e)");
      // The commission pays this relay (amm-p2p's commission key; the pools route's market.commissionPkh): the call's commissionPkh (push 6) and the commission output (4) rewritten from the fixtures' to ours.
      const baseChunks0 = UnlockingScript.fromBinary(base.inputs[0]!.unlockingScript!.toBinary()).chunks;
      const fxCom = Buffer.from(baseChunks0[6]!.data!).toString("hex");
      const ourCom = relayCommission;
      const outs = base.outputs.slice(0, 5).map((o, i) => i === 4 ? { satoshis: o.satoshis, lockingScript: LockingScript.fromHex(o.lockingScript.toHex().replace(fxCom, ourCom)) } : o);
      check(base.outputs[4]!.lockingScript.toHex().includes(fxCom), "the fixture swap's output 4 is the commission to its commissionPkh");
      const poolSats = pd.outputs[0]!.satoshis!;
      const exact = outs.reduce((k, o) => k + o.satoshis!, 0) - poolSats + 500;
      const ft = new Transaction();
      ft.addInput({ sourceTransaction: fund, sourceOutputIndex: 1, unlockingScriptTemplate: new P2PKH().unlock(taker), sequence: 0xffffffff });
      for (let k = 0; k < 5; k++) ft.addOutput({ lockingScript: takerLock, satoshis: exact });
      ft.addOutput({ lockingScript: takerLock, satoshis: fund.outputs[1]!.satoshis! - 5 * exact - 300 });
      await ft.sign();
      // The pool's scriptCode (unlock.zig poolScriptCode): the lock after the 1Color value prefix, past OP_NOP OP_CODESEPARATOR.
      const ps = pd.outputs[0]!.lockingScript.toBinary();
      let off = 33;
      const nb = ps[off]!;
      off += nb >= 0x01 && nb <= 0x4b ? 1 + nb : nb === 0x4c ? 2 + ps[off + 1]! : 1;
      const lockPart = ps.slice(off + 1);
      check(ps[off] === 0x6d && lockPart[0] === 0x61 && lockPart[1] === 0xab, "the pool output: value prefix, OP_2DROP, then OP_NOP OP_CODESEPARATOR");
      const scriptCode = (sdk as unknown as { Script: { fromBinary: (b: number[]) => unknown } }).Script.fromBinary(lockPart.slice(2));
      const baseChunks = baseChunks0.map((c, i) => (i === 6 ? { op: 20, data: Array.from(Buffer.from(ourCom, "hex")) } : c));
      const TS = (sdk as unknown as { TransactionSignature: { formatBip143: (p: Record<string, unknown>) => Uint8Array } }).TransactionSignature;
      /** The k-th swap on pool_deploy:0: swap_bsv_in's call and outputs, funded by the funding's output k, the validator's slot empty. */
      const swapOn = async (k: number) => {
        const t = new Transaction();
        t.version = base.version;
        t.lockTime = base.lockTime;
        t.addInput({ sourceTransaction: pd, sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
        t.addInput({ sourceTransaction: ft, sourceOutputIndex: k, unlockingScriptTemplate: new P2PKH().unlock(taker), sequence: 0xffffffff });
        for (const o of outs) t.addOutput({ lockingScript: o.lockingScript, satoshis: o.satoshis });
        const pre = TS.formatBip143({ sourceTXID: pd.id("hex"), sourceOutputIndex: 0, sourceSatoshis: poolSats, transactionVersion: t.version, otherInputs: [t.inputs[1]], outputs: t.outputs, inputIndex: 0, subscript: scriptCode, inputSequence: 0xffffffff, lockTime: t.lockTime, scope: 0x41 });
        const chunks = baseChunks.map((c, i) => (i === 1 || i === 10 ? { op: 0 } : i === 11 ? new LockingScript().writeBin(Array.from(pre)).chunks[0]! : c));
        t.inputs[0]!.unlockingScript = new UnlockingScript(chunks as never);
        await t.sign();
        return t;
      };
      // A session with B's instance (the handshake under /@<B>/, as the pages make it: RawBox's).
      const rb = new RawBox(keyWallet(admin), `${RR}/@${B}`);
      await rb.ready();
      const taf = (rb as unknown as { af: { fetch: (u: string, i: RequestInit) => Promise<Response> } }).af;
      const b64 = (b: number[] | Uint8Array) => ({ "/": { bytes: Buffer.from(b).toString("base64").replace(/=+$/, "") } });
      type Rec = { status?: string; reason?: string; detail?: string; txid?: string; poolState?: { outpoint?: string }; created?: number; updated?: number; expires?: unknown };
      // 0.17.0: no `expires` (skein-amm 0.44.0 refuses the argument).
      const relay = async (t: InstanceType<typeof Transaction>, pool: string): Promise<Rec | { error: string }> => {
        const res = await taf.fetch(`${RR}/@${B}/amm/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn: "amm.swap.submit", args: { funding: b64(ft.toAtomicBEEF()), swap: b64(t.toBinary()), pool, validator: b64(Buffer.from(SHARED, "hex")), peerId } }) });
        const j = await res.json().catch(() => ({})) as { result?: Rec; error?: { code?: string; message?: string } };
        return j.result ?? { error: `${res.status} ${JSON.stringify(j.error ?? j).slice(0, 200)}` };
      };
      /** `n` swaps on `pool`, relayed at once: exactly one accepted, the rest pool_spent with its continuation. */
      const race = async (n: number, from: number, pool: string) => {
        const txs = await Promise.all(Array.from({ length: n }, (_, i) => swapOn(from + i)));
        const got = await Promise.all(txs.map((t) => relay(t, pool)));
        const won = got.filter((g) => (g as Rec).status === "accepted") as Rec[];
        const lost = got.filter((g) => (g as Rec).status !== "accepted") as Rec[];
        const next = won[0]?.txid ? `${won[0].txid}_0` : "";
        check(won.length === 1 && lost.length === n - 1 && lost.every((g) => g.status === "refused" && g.reason === "pool_spent" && g.poolState?.outpoint === next) && got.every((g) => (g as Rec).expires === undefined),
          `${cross ? "cross-host: " : ""}${n} swaps on one pool output, relayed at once${cross ? " from another host (libp2p calls)" : ""}: one accepted (${String(won[0]?.txid).slice(0, 8)}…), ${n - 1} refused pool_spent with its continuation (${JSON.stringify(got.map((g) => (g as Rec).status ?? (g as { error: string }).error)).slice(0, 300)}; ${lost.map((g) => `${g.reason} ${String(g.poolState?.outpoint).slice(0, 8)}`).join(", ")})`);
        const moved = await until("the pools route at the new outpoint", async () => ((await get3(`/@${B}/amm/pools`)) as PoolsB | undefined)?.pools?.find((q) => q.poolId === poolB && q.outpoint === next), 30_000);
        const row = won[0]?.txid ? await get3(`/@${B}/amm/trades?txid=${won[0].txid}`) as Record<string, unknown> | undefined : undefined;
        check(!!moved && row?.poolId === poolB, `…/@<B>/amm/pools lists the pool at the accepted swap's continuation; its trade row (${JSON.stringify(row)?.slice(0, 120)})`);
        return won[0]?.txid;
      };
      // n on the deployed pool output.
      const w1 = await race(n, 0, `${pd.id("hex")}_0`);
      // Two more on the same output afterwards: the pool is spent and nothing in flight — pool_spent at once, none signed.
      if (w1 && n === 2) {
        const late = await Promise.all([3, 4].map(async (k) => relay(await swapOn(k), `${pd.id("hex")}_0`)));
        check(late.every((g) => (g as Rec).status === "refused" && (g as Rec).reason === "pool_spent" && (g as Rec).poolState?.outpoint === `${w1}_0`), `…two more on the spent output afterwards: refused pool_spent with the new state, none signed (${late.map((g) => (g as Rec).reason ?? (g as { error: string }).error).join(", ")})`);
      }
      // cross: the validator's host stopped — a call to it fails at once; the page's one re-ask fails the same way.
      if (cross && w1) {
        await z.stop().catch(() => {});
        z = undefined;
        if (ROCKS) await sleep(1500);
        const t5 = await swapOn(3);
        const t0 = Date.now();
        const dead = await relay(t5, `${w1}_0`) as Rec;
        const ms = Date.now() - t0;
        check(dead.status === "failed" && dead.reason === "unreachable" && !!dead.detail && ms < 15_000, `cross: a call to the stopped validator host: failed unreachable in ${ms} ms (${dead.detail ?? JSON.stringify(dead).slice(0, 200)})`);
        const again = await relay(t5, `${w1}_0`) as Rec;
        check(again.status === "failed" && again.reason === "unreachable" && (again.updated ?? 0) > (dead.updated ?? 0), `…the page's one re-ask of the same swap: relayed again (a failed record is retryable), failed the same way (${again.detail ?? JSON.stringify(again).slice(0, 200)})`);
      }
    } finally {
      await z?.stop().catch(() => {});
      await zr?.stop().catch(() => {});
      if (ROCKS) await sleep(1500);
      if (!process.env.KEEP) {
        rmSync(home3, { recursive: true, force: true });
        if (homeR) rmSync(homeR, { recursive: true, force: true });
      }
    }
  };
  await raceHost(2);
  await raceHost(3);
  await raceHost(2, true);

  // ------------------------------------------------ disable, enable again
  await send({ fn: "disable", args: { tokenId: A } });
  const off = await until("A stopped", async () => (await get(`/@${A}/amm/token`)).status === 404 ? true : undefined);
  await x.exchange.idle();
  check(!!off && x.db.get(A)?.status === "disabled" && (await getJson(`/@${SWAP}/amm/tokens`))[0].status === "disabled", "disable: swap's row disabled; the instance stopped (404 at /@<A>)");
  check(!((await getJson("/amm/pools")) as Array<{ tokenId?: string }>).some((y) => y.tokenId === A), "…GET /amm/pools after the disable: A's pools gone");
  await x.exchange.rootMessage(SWAP, "amm/admin", { fn: "enable", args: { tokenId: A } });
  const on = await until("A started", async () => (await get(`/@${A}/amm/token`)).status === 200 ? true : undefined);
  await x.exchange.idle();
  check(!!on && x.db.get(A)?.status === "enabled", "enable again by root (the host's key; no BEEF: swap's kept deploy): started, /@<A>/amm/token 200");
  check(!lines.some((l) => /created from image token/.test(l) && false) && lines.filter((l) => l.includes(`${A}: token-enabled: created from image token`)).length === 1, "…created once");

  // ------------------------------------------------ one token's terms (0.12.0): swap's event token-terms → the host's root message to A
  const termsOf = async () => (await getJson(`/@${A}/amm/terms`) as { validator?: { lpFeeBps?: number; validatorFeeBps?: number; commissionBps?: number } | null } | undefined)?.validator;
  await send({ fn: "terms", args: { tokenId: A, terms: { lpFeeBps: 40, validatorFeeBps: 6, commissionBps: 3 } } });
  const tA = await until("A's terms 40/6/3", async () => { const v = await termsOf(); return v && v.lpFeeBps === 40 && v.validatorFeeBps === 6 && v.commissionBps === 3 ? v : undefined; });
  await x.exchange.idle();
  check(!!tA && lines.some((l) => l.includes(`${A}: terms 40/6/3 sent`)), `terms {tokenId: A, terms 40/6/3} in amm/admin: the host sent root's terms to A (/@<A>/amm/terms validator ${JSON.stringify(tA)})`);
  await send({ fn: "terms", args: { tokenId: A, terms: null } });
  const mo = await until("A market only", async () => (await termsOf()) === null ? true : undefined);
  await x.exchange.idle();
  check(!!mo && lines.some((l) => l.includes(`${A}: terms null (market only) sent`)), "terms {tokenId: A, terms: null}: A market only (/@<A>/amm/terms validator null)");
  const nT = lines.filter((l) => /: terms .* sent/.test(l)).length;
  await send({ fn: "terms", args: { tokenId: `${"cd".repeat(32)}_0`, terms: null } });
  await new Promise((res) => setTimeout(res, 1500));
  await x.exchange.idle();
  check(lines.filter((l) => /: terms .* sent/.test(l)).length === nT && (await termsOf()) === null, "terms for a token not on the list: refused by swap, no event, nothing sent");
  await send({ fn: "terms", args: { tokenId: A, terms: { lpFeeBps: 30, validatorFeeBps: 5, commissionBps: 25 } } });
  check(!!(await until("A's terms back to the defaults", async () => (await termsOf())?.commissionBps === 25 ? true : undefined)), "terms back to 30/5/25 for the rest of the run");

  // ------------------------------------------------ the paid enable (0.15.3): a BEEF submission — one BEEF with the deploy and the payment
  const dP = deploy(0x50, "PPP", 3);
  const P = `${dP.id("hex")}_0`;
  const dQ = deploy(0x51, "QQQ", 0);
  const Q = `${dQ.id("hex")}_0`;
  const payer = sk.hostenv.parseKey("5a".repeat(32), "payer");
  const PAYER = payer.toPublicKey().toString();
  // The payer's coins: one mined funding transaction (a coin per payment), so every payment's ancestry is proven.
  const payHold = new esm.P2PKH().lock(payer.toPublicKey().toHash());
  const PF = new esm.Transaction();
  PF.addInput({ sourceTXID: "f5".repeat(32), sourceOutputIndex: 0, unlockingScript: esm.UnlockingScript.fromHex("51"), sequence: 0xffffffff });
  for (let i = 0; i < 6; i++) PF.addOutput({ lockingScript: payHold, satoshis: 50_000 });
  const hP = mineAlone(dP);
  pushHeader();
  const hQ = mineAlone(dQ);
  pushHeader();
  const hPF = mineAlone(PF as never, esm.MerklePath);
  pushHeader();
  check(!!(await until("swap's chain at the payer's funding", async () => { const t = await (await r.hydrate(SWAP)).kernel.chainTip(); return t && t.height >= hPF ? t : undefined; })), `P's deploy mined at ${hP}, Q's at ${hQ}, the payer's funding at ${hPF}`);
  /** A payment of `sats` from funding coin `k`: to the exchange's BRC-29 key for a fresh derivation (or `to`, a wrong key). */
  const payment = (k: number, sats: number, to?: InstanceType<typeof esm.P2PKH>) => {
    const prefix = esm.Utils.toBase64([k, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), suffix = esm.Utils.toBase64([k, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89]);
    const payee = new esm.KeyDeriver(payer as never).derivePublicKey([2, "3241645161d8"], `${prefix} ${suffix}`, swapId, false);
    const tx = new esm.Transaction();
    tx.addInput({ sourceTransaction: PF, sourceOutputIndex: k, unlockingScriptTemplate: new esm.P2PKH().unlock(payer) });
    tx.addOutput({ lockingScript: to ? to as never : new esm.P2PKH().lock(payee.toHash()), satoshis: sats });
    tx.addOutput({ lockingScript: payHold, satoshis: 50_000 - sats });
    return { tx, prefix, suffix };
  };
  const signed = async (p: ReturnType<typeof payment>) => { await p.tx.sign(); return p; };
  /** ONE BEEF: the deploy's and the payment's, each with its ancestry. */
  const bundle = (d: InstanceType<typeof Transaction>, p?: { tx: InstanceType<typeof esm.Transaction> }) => {
    const b = new esm.Beef();
    b.mergeBeef(Array.from(d.toBEEF()));
    if (p) b.mergeTransaction(p.tx);
    return Uint8Array.from(b.toBinary());
  };
  const enableUrl = (id: string, p?: { tx: InstanceType<typeof esm.Transaction>; prefix: string; suffix: string }) =>
    `${R}/amm/enable?tokenId=${encodeURIComponent(id)}${p ? `&paymentTxid=${p.tx.id("hex")}&paymentVout=0&derivationPrefix=${encodeURIComponent(p.prefix)}&derivationSuffix=${encodeURIComponent(p.suffix)}` : ""}`;
  // A stock client (signed, BRC-104) that hands a 402 back instead of paying it: this route takes the payment in its BEEF.
  const af = new esm.AuthFetch(keyWallet(payer) as never);
  (af as unknown as { handlePaymentAndRetry: (u: string, c: unknown, res: Response) => Promise<Response> }).handlePaymentAndRetry = async (_u, _c, res) => res;
  const post = async (url: string, body: Uint8Array) => { const res = await af.fetch(url, { method: "POST", headers: { "content-type": "application/octet-stream" }, body }); return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }; };
  const enableRow = async () => (await (await r.hydrate(SWAP)).kernel.dispatch()).rows.find((x) => x.transport === "http" && x.address === "/amm/enable") as Record<string, unknown> | undefined;
  {
    const row = await enableRow();
    const fs = (row?.filters as string[] | undefined)?.join(",");
    check(fs === "kernel.brc104,kernel.beef,amm.enable-check" && row?.price === undefined, `swap's route POST /amm/enable: filters ${fs}, no kernel.pay, no price on the row`);
  }
  const good = await signed(payment(2, 2000));
  const off0 = await post(enableUrl(P, good), bundle(dP, good));
  check(off0.status === 403 && off0.body.code === "ERR_PAID_ENABLE_OFF", `no price: 403 ${String(off0.body.code)}`);
  await send({ fn: "price", args: { sats: 2000 } });
  const priced = await until("/amm/defaults enablePriceSats 2000", async () => (await getJson(`/@${SWAP}/amm/defaults`) as { enablePriceSats?: number })?.enablePriceSats === 2000 ? true : undefined);
  check(!!priced && (await enableRow())?.price === undefined, "the admin's price {sats: 2000}: /amm/defaults enablePriceSats 2000 (the swap app's record; the route row unpriced)");
  const noPay = await post(enableUrl(P), bundle(dP));
  check(noPay.status === 402 && noPay.body.code === "ERR_PAYMENT_REQUIRED" && noPay.body.satoshisRequired === 2000, `no payment named: 402 ${String(noPay.body.code)}, satoshisRequired ${String(noPay.body.satoshisRequired)}`);
  const badDeploy = await post(enableUrl(`${"ab".repeat(32)}_0`, good), bundle(dP, good));
  check(badDeploy.status === 400 && badDeploy.body.code === "ERR_BAD_DEPLOY", `the BEEF holds no deploy of the named token: 400 ${String(badDeploy.body.code)}`);
  const small = await signed(payment(0, 1999));
  const tooSmall = await post(enableUrl(P, small), bundle(dP, small));
  check(tooSmall.status === 402 && tooSmall.body.code === "ERR_PAYMENT_TOO_SMALL" && tooSmall.body.satoshisRequired === 2000, `a payment under the price: 402 ${String(tooSmall.body.code)}`);
  const wrong = await signed(payment(1, 2000, new esm.P2PKH().lock(esm.PrivateKey.fromRandom().toPublicKey().toHash()) as never));
  const wrongKey = await post(enableUrl(P, wrong), bundle(dP, wrong));
  check(wrongKey.status === 400 && wrongKey.body.code === "ERR_INVALID_PAYMENT" && !(await getJson(`/@${SWAP}/amm/tokens`) as Array<{ tokenId: string }>).some((t) => t.tokenId === P), `a payment to another key: 400 ${String(wrongKey.body.code)}, nothing enabled`);
  // A good bundle: enabled; the payment handed to swap's wallet (its internalize sends it on).
  const t2 = Date.now();
  const ok = await post(enableUrl(P, good), bundle(dP, good));
  const res = ok.body.result as Record<string, unknown> | undefined;
  check(ok.status === 200 && res?.tokenId === P && res.status === "enabled" && res.paidBy === PAYER && res.paymentTxid === good.tx.id("hex") && res.satoshisPaid === 2000 && !("deploy" in res), `a good bundle: 200, P enabled, the row keeps the payment (${JSON.stringify(res)?.slice(0, 220)})`);
  const upP = await until("/@P/amm/token", async () => { const t = await get(`/@${P}/amm/token`); return t.status === 200 ? t : undefined; }, 60_000);
  await x.exchange.idle();
  keep(x, P);
  check(!!upP && (await rootOf(x, P)).join() === SHARED, `the host reacted to token-enabled: P's instance up, owned by the host's key (${Date.now() - t2} ms)`);
  const kP = (await r.hydrate(P)).kernel;
  const termsP = await until("P's amm/terms", async () => { const c = await kP.call("head", "amm/terms"); return c ? await kP.store.get(c as never) as Record<string, unknown> : undefined; });
  check(!!termsP && termsP.commissionBps === 25 && termsP.minLegSats === 1000, `…with the default terms (amm/terms ${JSON.stringify(termsP)})`);
  const listedP = (await getJson(`/@${SWAP}/amm/tokens`) as Array<Record<string, unknown>>).find((t) => t.tokenId === P);
  check(listedP?.status === "enabled" && listedP.paidBy === PAYER && listedP.satoshisPaid === 2000, "/amm/tokens: P enabled, paidBy and satoshisPaid on its row");
  const wal = await until("swap's wallet holds the payment", async () => { const v = await getJson("/amm/wallet") as { sats?: number; outputs?: number } | undefined; return v?.sats === 2000 ? v : undefined; });
  check(wal?.sats === 2000 && wal.outputs === 1, `GET /amm/wallet: ${JSON.stringify(wal)} (the payment, internalized by swap's wallet)`);
  check(await until("the payment at Arcade", () => arcade.txs.has(good.tx.id("hex")) ? true : undefined, 30_000) === true, "…the wallet's internalize sent it on (Arcade has it, through the chain app)");
  const replay = await post(enableUrl(Q, good), bundle(dQ, good));
  check(replay.status === 409 && replay.body.code === "ERR_PAYMENT_REPLAYED", `the same payment for another token (Q): 409 ${String(replay.body.code)}`);
  const again2 = await signed(payment(3, 2000));
  const twice = await post(enableUrl(P, again2), bundle(dP, again2));
  check(twice.status === 409 && twice.body.code === "ERR_TOKEN_ENABLED", `a second request for P: 409 ${String(twice.body.code)}`);
  // The admin's withdraw (0.15.2): a standard BRC-29 payment to the message's sender, built by swap's own program
  // through its wallet (list, one noSend createAction of every coin, no change), answered at once and handed over
  // UNSENT: the host broadcasts nothing; the admin's wallet takes it in.
  const posted0 = arcade.posts.length;
  const t3 = Date.now();
  await send({ fn: "withdraw" });
  const kept = await until("the withdrawal kept", async () => { const v = await getJson("/amm/wallet") as { sats?: number; withdrawals?: Array<Record<string, unknown>> } | undefined; return v?.withdrawals?.length ? v : undefined; }, 60_000);
  const w1 = kept?.withdrawals?.[0];
  const fee1 = Math.ceil((4 + 1 + 147 + 1 + (8 + 1 + 25) + (8 + 1 + 25) + 4) * 100 / 1000);
  check(!!w1 && w1.n === 1 && w1.sats === 2000 - fee1 && w1.outputIndex === 0 && w1.senderIdentityKey === swapId && typeof w1.derivationPrefix === "string" && typeof w1.derivationSuffix === "string" && kept!.sats === 0, `withdraw {fn: "withdraw"} (no args): kept at once, no block mined (${Date.now() - t3} ms): ${JSON.stringify(kept)}`);
  if (w1) {
    const wb = await fetch(`${R}/amm/wallet/tx?n=1`);
    const wbb = [...new Uint8Array(await wb.arrayBuffer())];
    const wtx = esm.Transaction.fromAtomicBEEF(wbb);
    const keyID = `${String(w1.derivationPrefix)} ${String(w1.derivationSuffix)}`;
    const payee = new esm.KeyDeriver(admin as never).derivePrivateKey([2, "3241645161d8"], keyID, String(w1.senderIdentityKey)).toPublicKey();
    const want = new esm.P2PKH().lock(payee.toHash()).toHex();
    const verifies = await wtx.verify("scripts only").catch(() => false);
    check(wb.status === 200 && wtx.id("hex") === w1.txid && wtx.outputs.length === 1 && wtx.outputs[0]!.satoshis === 2000 - fee1 && wtx.outputs[0]!.lockingScript.toHex() === want && verifies === true,
      `GET /amm/wallet/tx?n=1: the Atomic BEEF of one transaction that verifies (scripts) and pays its one output, 2000 less the fee ${fee1}, to the admin's BRC-29 key (counterparty swap, key id the record's), no change`);
    const sentByHost = arcade.posts.slice(posted0).some((b) => FakeArcade.txOf(b).id("hex") === w1.txid);
    check(!sentByHost && !arcade.txs.has(String(w1.txid)), "…not broadcast by the host: Arcade has not seen it (the admin's wallet takes it in and sends it)");
    check((await get("/amm/wallet/tx?n=2")).status === 404, "GET /amm/wallet/tx?n=2: 404");
  }
  await send({ fn: "withdraw" });
  await (await r.hydrate(SWAP)).kernel.idle();
  await sleep(1500);
  await x.exchange.idle();
  check((await getJson("/amm/wallet") as { withdrawals?: unknown[] }).withdrawals?.length === 1, "withdraw again with nothing in the wallet: refused, nothing kept");
  await send({ fn: "withdraw", args: { lockingScript: "76a9" } });
  await (await r.hydrate(SWAP)).kernel.idle();
  check((await getJson("/amm/wallet") as { withdrawals?: unknown[] }).withdrawals?.length === 1, "withdraw with args (a script from the page): refused");
  // 0.15.4: a bundle whose entries are NOT parents first (the payment, then the deploy, then the payment's funding):
  // the door takes it; the wallet's internalize gets the payment's own BEEF, cut and written parents first.
  const dR = deploy(0x52, "RRR", 1);
  const R2 = `${dR.id("hex")}_0`;
  const hR = mineAlone(dR);
  pushHeader();
  await until("swap's chain at R's deploy", async () => { const t = await (await r.hydrate(SWAP)).kernel.chainTip(); return t && t.height >= hR ? t : undefined; });
  const sats0 = ((await getJson("/amm/wallet")) as { sats?: number }).sats ?? 0;
  const odd = await signed(payment(5, 2000));
  const ob = new esm.Beef();
  ob.mergeBeef(Array.from(dR.toBEEF()));
  ob.mergeTransaction(odd.tx);
  const oddById = new Map(ob.txs.map((t) => [t.txid, t]));
  ob.txs.splice(0, ob.txs.length, oddById.get(odd.tx.id("hex"))!, oddById.get(dR.id("hex"))!, oddById.get(PF.id("hex"))!);
  const ow = new esm.Utils.Writer();
  ob.toWriter(ow as never);
  const oddBytes = Uint8Array.from(ow.toArray());
  const parsedOdd = esm.Beef.fromBinary(Array.from(oddBytes));
  check(parsedOdd.txs.map((t) => t.txid).join() === [odd.tx.id("hex"), dR.id("hex"), PF.id("hex")].join(), "a bundle written NOT parents first: the payment, the deploy, then the payment's funding");
  const okOdd = await post(enableUrl(R2, odd), oddBytes);
  check(okOdd.status === 200 && (okOdd.body.result as { tokenId?: string } | undefined)?.tokenId === R2, `…enabled (${okOdd.status} ${JSON.stringify(okOdd.body).slice(0, 120)})`);
  const walOdd = await until("swap's wallet holds the odd bundle's payment", async () => { const v = await getJson("/amm/wallet") as { sats?: number } | undefined; return v?.sats === sats0 + 2000 ? v : undefined; }, 30_000);
  check(walOdd?.sats === sats0 + 2000 && !lines.some((l) => /wallet step 1 → errored · wallet: NotParentsFirst/.test(l)), `…the coin in /amm/wallet (${JSON.stringify(walOdd)}): the wallet took the payment's own BEEF, parents first`);
  await until("R up", async () => (await get(`/@${R2}/amm/token`)).status === 200 ? true : undefined, 60_000);
  await x.exchange.idle();
  keep(x, R2);
  // Disabled by the admin: the paid route refuses it (only the admin enables it again).
  await send({ fn: "disable", args: { tokenId: P } });
  await until("P stopped", async () => (await get(`/@${P}/amm/token`)).status === 404 ? true : undefined);
  await x.exchange.idle();
  const late = await signed(payment(4, 2000));
  const dis = await post(enableUrl(P, late), bundle(dP, late));
  check(dis.status === 409 && dis.body.code === "ERR_TOKEN_DISABLED", `P disabled by the admin, then a paid enable: 409 ${String(dis.body.code)}`);

  // ------------------------------------------------ discovery on / off
  await send({ fn: "discovery", args: { on: true } });
  const dOn = await until("discovery started", async () => (await get(`/@${DISCOVERY}/1color/listTopicManagers`)).status === 200 ? true : undefined);
  await x.exchange.idle();
  const dtm = await getJson(`/@${DISCOVERY}/1color/listTopicManagers`), dls = await getJson(`/@${DISCOVERY}/1color/listLookupServiceProviders`);
  check(!!dOn && "tm_color" in (dtm ?? {}) && "ls_color" in (dls ?? {}), `discovery {on:true}: started, serves ${Object.keys(dtm ?? {}).join(", ")} · ${Object.keys(dls ?? {}).join(", ")}`);
  const sub = await fetch(`${R}/submit`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-topics": JSON.stringify(["tm_color"]) }, body: Uint8Array.from(dA.toBEEF()) });
  check(sub.status === 200, `bare-host POST /submit X-Topics tm_color: routed to discovery (${sub.status} ${(await sub.text()).slice(0, 120)})`);
  await send({ fn: "discovery", args: { on: false } });
  const dOff = await until("discovery stopped", async () => (await get(`/@${DISCOVERY}/1color/listTopicManagers`)).status === 404 ? true : undefined);
  check(!!dOff && JSON.parse((await get(`/@${SWAP}/amm/discovery`)).text).on === false, "discovery {on:false}: stopped (404)");
  await send({ fn: "discovery", args: { on: true } });
  check(!!(await until("discovery started again", async () => (await get(`/@${DISCOVERY}/1color/listTopicManagers`)).status === 200 ? true : undefined)), "discovery {on:true} again: started");
  { const t = await get(`/@${DISCOVERY}/1color/tokens`); check(t.status === 200 && Array.isArray(JSON.parse(t.text)), `discovery: GET /@discovery/1color/tokens ${t.status} (P13)`); }
  { const rowsD = await getJson(`/@${DISCOVERY}/1color/tokens?ids=${A}`) as Array<{ amount?: number; height?: number | null }> | undefined; check(rowsD?.[0]?.amount === 21_000_000 && rowsD[0].height === hA, `discovery's A row (0.13.0, D5): amount ${rowsD?.[0]?.amount}, height ${rowsD?.[0]?.height} (A's deploy mined at ${hA})`); }
  // 0.15.1 (skein-1color 0.16.0): the list's search (q: symbol or token id STARTS WITH) and cursor (after=<tokenId>).
  {
    const subP = await fetch(`${R}/submit`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-topics": JSON.stringify(["tm_color"]) }, body: Uint8Array.from(dP.toBEEF()) });
    check(subP.status === 200, `P's deploy submitted to tm_color (${subP.status})`);
    type Row = { tokenId: string; sym: string };
    const full = await until("discovery lists A and P", async () => { const l = await getJson(`/@${DISCOVERY}/1color/tokens`) as Row[] | undefined; return l && l.length >= 2 && l.some((r) => r.tokenId === P) ? l : undefined; }) ?? [];
    const ids = (l: Row[] | undefined) => (l ?? []).map((r) => r.tokenId).join(",");
    const want = (q: string) => full.filter((r) => r.sym.toLowerCase().startsWith(q.toLowerCase()) || r.tokenId.startsWith(q)).map((r) => r.tokenId).join(",");
    for (const q of ["aA", "AAA", "ppp", "p"]) {
      const got = await getJson(`/@${DISCOVERY}/1color/tokens?q=${encodeURIComponent(q)}`) as Row[] | undefined;
      check(ids(got) === want(q) && ids(got).includes(/^a/i.test(q) ? A : P), `discovery ?q=${q} (by symbol prefix): ${ids(got).split(",").map((t) => t.slice(0, 8)).join(" ")}`);
    }
    const byId = await getJson(`/@${DISCOVERY}/1color/tokens?q=${A.slice(0, 7)}`) as Row[] | undefined;
    check(ids(byId) === want(A.slice(0, 7)) && ids(byId).includes(A), `discovery ?q=${A.slice(0, 7)} (by token id prefix): ${ids(byId).split(",").map((t) => t.slice(0, 8)).join(" ")}`);
    const p1 = await getJson(`/@${DISCOVERY}/1color/tokens?limit=1`) as Row[] | undefined;
    const p2 = await getJson(`/@${DISCOVERY}/1color/tokens?limit=1&after=${p1?.[0]?.tokenId}`) as Row[] | undefined;
    const pEnd = await getJson(`/@${DISCOVERY}/1color/tokens?after=${full.at(-1)?.tokenId}`) as Row[] | undefined;
    check(ids(p1) === full[0]?.tokenId && ids(p2) === full[1]?.tokenId && pEnd?.length === 0, `discovery paging with after: ${ids(p1).slice(0, 8)} → ${ids(p2).slice(0, 8)} → [] (the list ${ids(full).split(",").map((t) => t.slice(0, 8)).join(" ")})`);
    const qa = await getJson(`/@${DISCOVERY}/1color/tokens?q=aaa&after=${full[0]?.tokenId}`) as Row[] | undefined;
    check(ids(qa) === full.slice(1).filter((r) => want("aaa").split(",").includes(r.tokenId)).map((r) => r.tokenId).join(","), `discovery ?q=aaa&after=<first>: ${ids(qa) || "[]"}`);
    const unknown = await get(`/@${DISCOVERY}/1color/tokens?after=${"ee".repeat(32)}_0`);
    const withSkip = await get(`/@${DISCOVERY}/1color/tokens?after=${A}&skip=1`);
    check(unknown.status === 400 && withSkip.status === 400, `discovery: an unknown after ${unknown.status}, after beside skip ${withSkip.status}`);
  }
  await x.exchange.idle();

  // ------------------------------------------------ restart: reconcile
  const rows0 = x.db.list().map((r) => `${r.handle}:${r.status}`).sort().join(" ");
  const created0 = lines.filter((l) => /created \S+ .* from the/.test(l)).length;
  await x.stop();
  x = undefined;
  if (ROCKS) await sleep(1500);
  x = await startExchange(sk, settings(sk, env));
  await x.exchange.idle();
  const rows1 = x.db.list().map((r) => `${r.handle}:${r.status}`).sort().join(" ");
  const created1 = lines.filter((l) => /created \S+ .* from the/.test(l)).length;
  check(rows0 === rows1 && created0 === created1, `restart: reconcile created nothing; the table as swap says (${rows1})`);
  check((await get(`/@${A}/amm/token`)).status === 200 && (await get(`/@${DISCOVERY}/1color/listTopicManagers`)).status === 200, "restart: A and discovery serve");
  // swap says A disabled → the restart stops it (the host table follows swap, not its own last state).
  await send({ fn: "disable", args: { tokenId: A } });
  await until("A stopped", async () => (await get(`/@${A}/amm/token`)).status === 404 ? true : undefined);
  await x.exchange.idle();
  x.db.setStatus(A, "enabled"); // the host's table out of step with swap (as after a crash between the fact and the reaction)
  await x.stop();
  x = undefined;
  if (ROCKS) await sleep(1500);
  x = await startExchange(sk, settings(sk, env));
  await x.exchange.idle();
  check(x.db.get(A)?.status === "disabled", `restart with the host's table out of step (A enabled there, disabled on swap): reconciled to swap — A ${x.db.get(A)?.status}`);

  // ------------------------------------------------ swap's pages follow the package (an upgrade)
  const pkgDir = join(mkdtempSync(join(tmpdir(), "ox-accept-app-")), "swap");
  cpSync(SWAP_APP_DIR, pkgDir, { recursive: true });
  const bumped = `${swapAppVersion()}-accept`;
  const mf = JSON.parse(readFileSync(join(pkgDir, "etc/app.json"), "utf8")) as { version: string };
  mf.version = bumped;
  writeFileSync(join(pkgDir, "etc/app.json"), `${JSON.stringify(mf, null, 2)}\n`);
  writeFileSync(join(pkgDir, "www/accept.txt"), "the bumped package\n");
  await x.stop();
  x = undefined;
  if (ROCKS) await sleep(1500);
  x = await startExchange(sk, settings(sk, env), { swapAppDir: pkgDir });
  await x.exchange.idle();
  const ver = async () => { const l = await x!.host.router.hydrate(SWAP); const c = await l.kernel.call("head", "amm/app"); return c ? (await l.kernel.store.get(c as never) as { version?: string }).version : undefined; };
  check(lines.some((l) => l.includes(`swap: pages updated to ${bumped} (from ${swapAppVersion()}`)) && await ver() === bumped, `restart with a packaged swap app ${bumped}: installed into swap as root (amm/app ${await ver()})`);
  check((await get("/accept.txt")).text === "the bumped package\n", "…its pages served (GET /accept.txt at the bare host)");
  {
    const o = await get("/api/openapi.json");
    const doc = o.status === 200 ? JSON.parse(o.text) as { openapi?: string; paths?: Record<string, unknown> } : undefined;
    const page = await get("/api/");
    check(doc?.openapi === "3.1.0" && !!doc.paths?.["/@{token}/amm/pools"] && page.status === 200 && page.text.includes("openapi.json"), `the API docs: GET /api/openapi.json ${o.status} (OpenAPI ${doc?.openapi}, ${Object.keys(doc?.paths ?? {}).length} paths), GET /api/ ${page.status} (P18)`);
  }
  check((await getJson(`/@${SWAP}/amm/tokens`) as Array<{ tokenId: string }>).some((t) => t.tokenId === A) && (await getJson(`/@${SWAP}/amm/admin`) as { claimant?: string }).claimant === ADMIN && (await rootOf(x, SWAP, "amm.admin")).join() === ADMIN, "…swap's state kept: A on the list, the claimant, its amm.admin grant");
  await send({ fn: "defaults", args: { market: { minCommissionBps: 3 } } });
  check(!!(await until("the admin's defaults after the upgrade", async () => (await getJson(`/@${SWAP}/amm/defaults`) as { market?: { minCommissionBps?: number } })?.market?.minCommissionBps === 3 ? true : undefined)), "…the admin's message in amm/admin runs after the upgrade (defaults market 3)");
  const n0 = lines.filter((l) => /swap: pages updated to/.test(l)).length;
  await x.stop();
  x = undefined;
  if (ROCKS) await sleep(1500);
  x = await startExchange(sk, settings(sk, env));
  await x.exchange.idle();
  check(lines.filter((l) => /swap: pages updated to/.test(l)).length === n0 + 1 && await ver() === swapAppVersion(), `restart with the package's own app again: installed back (${await ver()})`);
  rmSync(dirname(pkgDir), { recursive: true, force: true });
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
} finally {
  await x?.stop().catch(() => {});
  await arcade.close();
  for (const s of streams) s.end();
  sse.close();
  if (ROCKS) await sleep(1500);
  if (!REPLAY_DIR) process.stdout.write("  (the replays skipped: SKEIN_REPLAY_DIR names no skein checkout with the native kernel)\n");
  for (const { spec, h } of REPLAY_DIR ? stores : []) {
    const rp = spawnSync("node", ["--experimental-strip-types", "--no-warnings", join(REPLAY_DIR!, "kernel-zig/equiv/replays.ts"), spec], { encoding: "utf8", env: { ...process.env, ...(kernel ? { SKEIN_KERNEL_BIN: kernel } : {}) } });
    if (rp.status !== 0) process.stdout.write(rp.stdout.slice(-1500) + rp.stderr.slice(-1500));
    check(rp.status === 0 && /identical .*the source store reproduced exactly/.test(rp.stdout), `${h}: the store replays to itself exactly`);
  }
}
if (failures && process.env.KEEP_LOG) writeFileSync(join(tmpdir(), "ox-accept.log"), lines.join("\n"));
if (process.env.KEEP) process.stdout.write(`kept ${home}\n`); else rmSync(home, { recursive: true, force: true });
process.stdout.write(failures ? `open exchange acceptance (${BACKEND}): ${failures} FAILED\n` : `open exchange acceptance (${BACKEND}): all ok\n`);
process.exit(failures ? 1 : 0);
