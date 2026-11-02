// open-exchange#1 acceptance: the Open Exchange host on a scratch one-key host (regtest; the wasm kernel
// over the host's one SQLite database by default — the distributable's shape; RocksDB with the native
// kernel process with SKEIN_EQUIV_STORE=rocksdb, a native serve per SQLite file with =file), through the commands' own code (host/cli.ts `setup`,
// `startExchange`) and the front door over HTTP (root's messages by BRC-104, as a wallet sends them).
//
//   setup                → swap and discovery born owned by the host's key (0.5.0); /amm/admin {} (unclaimed);
//                          discovery serving tm_color and ls_color; a stranger's message in amm/admin runs nothing
//   the claim            → the admin's own {fn: "claim"} in box `amm/claim` (BRC-104, as the Settings page sends it):
//                          /amm/admin names it, the host grants it amm.admin; root stays [host]; /skeins?key=<admin>
//                          does not list swap; a second claim by another key refused
//   run                  → reconciled: swap's discovery is off, so discovery stopped
//   root: defaults terms, then enable {tokenId, beef}   → the host reacts: the instance <id> born owned, its deploy
//                          event admitted (amm/token), the three names served, beats, the terms sent;
//                          bare-host /lookup ls_color_<id> routed; /amm/tokens: enabled, no url
//   disable              → stopped (404 at /@<id>); enable again (no BEEF), by root (the host's key) → started
//   discovery off / on   → stopped / started
//   restart the host     → reconcile creates nothing and starts what swap says
//   swap's pages         → a restart with a packaged swap app of another version installs it into swap (as root),
//                          the same version installs nothing; swap's state and the claimant's grant kept
//   every store replays to itself — by the NATIVE reference (`skein-kernel replay`, skein's
//   kernel-zig/equiv/replays.ts) when SKEIN_REPLAY_DIR names a skein checkout with its kernel built;
//   a store the wasm kernel wrote is then checked against the native kernel's replay of it
//
//   [SKEIN_REPLAY_DIR=<skein checkout>] [SKEIN_KERNEL_BIN=<a native kernel>] [SKEIN_EQUIV_STORE=rocksdb|file] node scripts/accept/ox-accept.ts
//   (built: node dist/scripts/accept/ox-accept.js — what a package install runs)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as httpServer, type ServerResponse } from "node:http";
import { createServer } from "node:net";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DISCOVERY, SWAP } from "../../host/exchange.ts";
import { load, skein, SWAP_APP_DIR, swapAppVersion } from "../../host/skein.ts";
import { setup, settings, startExchange, type Env, type Running } from "../../host/cli.ts";

type Sdk = typeof import("@bsv/sdk");
// @bsv/sdk as skein's own dependency (resolved from the skein package).
const sdk = await import(pathToFileURL(createRequire(fileURLToPath(import.meta.resolve("@dcasegr/skein/package.json"))).resolve("@bsv/sdk")).href) as Sdk;
const { LockingScript, MerklePath, P2PKH, PrivateKey, Transaction, UnlockingScript } = sdk;
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
function mineAlone(t: InstanceType<typeof Transaction>): number {
  const height = headers.length + 1;
  const cb = (height * 17 % 256).toString(16).padStart(2, "0").repeat(32);
  t.merklePath = new MerklePath(height, [[{ offset: 0, hash: cb }, { offset: 1, hash: t.id("hex"), txid: true }]]);
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

// ---------------------------------------------------------------- the host
const home = mkdtempSync(join(tmpdir(), "ox-accept-"));
const shared = new PrivateKey("0e0e0e", 16);
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

  // ------------------------------------------------ setup
  const t0 = Date.now();
  const code = await setup(sk, env, []);
  check(code === 0, `open-exchange setup: exit ${code} (${Date.now() - t0} ms)`);
  check(lines.some((l) => /swap: unclaimed — the first wallet to claim it on Settings becomes its admin/.test(l)), "setup says: swap unclaimed — the first wallet to claim it on Settings becomes its admin");
  check(lines.some((l) => /made swap .*\(owned by the host's key\)/.test(l)), "setup: swap made, owned by the host's key");
  const old = await setup(sk, { ...env, err: (l) => lines.push(`ERR ${l}`) }, ["--admin", ADMIN]);
  check(old === 2, `setup --admin: refused (no such flag; usage, exit ${old})`);
  const again = await setup(sk, env, []);
  check(again === 0 && lines.some((l) => /nothing to do \(everything exists\)/.test(l)), "setup again: a no-op (nothing to do)");
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
  check(JSON.stringify(await getJson(`/@${SWAP}/amm/defaults`)) === "{}", `a stranger's defaults in amm/admin (unclaimed swap): gated, nothing written (${JSON.stringify(await getJson(`/@${SWAP}/amm/defaults`))})`);

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
  await send({ fn: "defaults", args: { terms: { lpFeeBps: 30, validatorFeeBps: 5, commissionBps: 25 }, market: { minCommissionBps: 2 } } });
  const df = await until("the defaults", async () => { const d = await getJson(`/@${SWAP}/amm/defaults`) as { terms?: unknown } | undefined; return d?.terms ? d : undefined; });
  check(!!df, `defaults set by root: ${JSON.stringify(df)}`);
  const t1 = Date.now();
  await send({ fn: "enable", args: { tokenId: A, beef: Uint8Array.from(dA.toAtomicBEEF()) } });
  const rowA = await until("A enabled on swap", async () => (await getJson(`/@${SWAP}/amm/tokens`) as Array<Record<string, unknown>>)?.find((t) => t.tokenId === A && t.status === "enabled"));
  check(!!rowA && !("url" in rowA) && !("deploy" in rowA) && rowA.sym === "AAA", `swap: A enabled, a fact (${JSON.stringify(rowA)})`);
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
  check(!!terms && JSON.stringify(terms).includes("25"), `A: the default terms sent as root's message (amm/terms ${JSON.stringify(terms)})`);
  const market = await until("A's amm/market", async () => { const c = await kA.call("head", "amm/market"); return c ? await kA.store.get(c as never) as Record<string, unknown> : undefined; });
  check(!!market, `A: the default market sent (amm/market ${JSON.stringify(market)})`);
  const lk = await fetch(`${R}/lookup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: lsA, query: { type: "color-admission", version: 1, assetId: A, topic: tmA, outpoints: [`${dA.id("hex")}.0`] } }) });
  const lkb = await lk.json().catch(() => ({})) as { type?: string; outputs?: unknown[] };
  check(lk.status === 200 && lkb.type === "output-list" && (lkb.outputs?.length ?? 0) === 1, `bare-host POST /lookup ${lsA.slice(0, 18)}…: routed to A, color-admission answers the deploy (${lk.status} ${JSON.stringify(lkb).slice(0, 100)})`);
  const liveT = await until("tm_color_A-live", async () => { const v = await getJson(`/@${A}/amm/.live/${tmA}-live`) as unknown[] | undefined; return v?.length ? v : undefined; }, 60_000);
  check(!!liveT, `beats on tm_color_<A>-live (${liveT?.length ?? 0})`);
  const liveL = await until("ls_amm_A-live", async () => { const v = await getJson(`/@${A}/amm/.live/${ammA}-live`) as unknown[] | undefined; return v?.length ? v : undefined; }, 60_000);
  check(!!liveL, `beats on ls_amm_<A>-live (${liveL?.length ?? 0})`);

  // ------------------------------------------------ disable, enable again
  await send({ fn: "disable", args: { tokenId: A } });
  const off = await until("A stopped", async () => (await get(`/@${A}/amm/token`)).status === 404 ? true : undefined);
  await x.exchange.idle();
  check(!!off && x.db.get(A)?.status === "disabled" && (await getJson(`/@${SWAP}/amm/tokens`))[0].status === "disabled", "disable: swap's row disabled; the instance stopped (404 at /@<A>)");
  await x.exchange.rootMessage(SWAP, "amm/admin", { fn: "enable", args: { tokenId: A } });
  const on = await until("A started", async () => (await get(`/@${A}/amm/token`)).status === 200 ? true : undefined);
  await x.exchange.idle();
  check(!!on && x.db.get(A)?.status === "enabled", "enable again by root (the host's key; no BEEF: swap's kept deploy): started, /@<A>/amm/token 200");
  check(!lines.some((l) => /created from image token/.test(l) && false) && lines.filter((l) => /token-enabled: created from image token/.test(l)).length === 1, "…created once");

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
