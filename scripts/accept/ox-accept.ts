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

type Sdk = typeof import("@bsv/sdk");
// @bsv/sdk as skein's own dependency (resolved from the skein package).
const sdk = await import(pathToFileURL(createRequire(fileURLToPath(import.meta.resolve("@dcasegr/skein/package.json"))).resolve("@bsv/sdk")).href) as Sdk;
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
/** An event stream's events (`event: pools`, data JSON), as they come; `close` ends it. */
function sseEvents(url: string) {
  const ac = new AbortController();
  const got: unknown[] = [];
  let status = 0;
  const done = (async () => {
    const res = await fetch(url, { headers: { accept: "text/event-stream" }, signal: ac.signal });
    status = res.status;
    const reader = res.body!.getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += new TextDecoder().decode(value);
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
        const ev = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = /^data: (.*)$/m.exec(ev)?.[1];
        if (/^event: pools$/m.test(ev) && data !== undefined) got.push(JSON.parse(data));
      }
    }
  })().catch(() => {});
  return { got, status: () => status, close: () => { ac.abort(); return done; } };
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
  const s2 = sseEvents(p2);
  const first2 = await until("the first pools event", () => s2.got.length ? s2.got[0] : undefined, 15_000) as { market?: { minCommissionBps?: unknown }; pools?: unknown[] } | undefined;
  check(s2.status() === 200 && !!first2 && Array.isArray(first2.pools) && first2.pools.length === 0, `GET /@<A>/amm/pools as an event stream: the first event, no pools yet (${JSON.stringify(first2)})`);
  const subT = await submitA(T);
  check(subT.status === 200, `T (A's deploy split in three) submitted to ${tmA.slice(0, 18)}… (${subT.status} ${subT.text.slice(0, 120)})`);
  const tPools = Date.now();
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
  check(b2.market?.minCommissionBps === 2 && typeof b2.market.commissionPkh === "string", `…the market: ${JSON.stringify(b2.market)}`);
  const vs = b2.validators ?? [];
  check(vs.some((v) => v.identity === SHARED && v.peerId === (liveT?.[0] as { from?: string } | undefined)?.from) && !vs.some((v) => v.identity === stranger.toPublicKey().toString()), `…validators: the beating one (the host key, its peer ID), not the stranger (${JSON.stringify(vs.map((v) => `${String(v.identity).slice(0, 8)}…/${String(v.peerId).slice(0, 12)}…`))})`);
  const next2 = await until("a pools event with P0", () => s2.got.find((e) => (e as { pools?: Array<{ outpoint?: string }> }).pools?.some((p) => p.outpoint === p0)), 30_000);
  check(!!next2 && s2.got.length >= 2, `…the stream sent the answer again once it changed (${s2.got.length} events; P0 in it ${Date.now() - tPools} ms after the pools' submission began)`);
  await s2.close();
  const g1 = await fetch(`${R}/amm/pools`);
  const b1 = await g1.json().catch(() => undefined) as Array<Record<string, unknown>> | undefined;
  check(g1.status === 200 && b1?.length === 1 && b1[0]!.tokenId === A && b1[0]!.outpoint === p0 && g1.headers.get("cache-control") === "public, max-age=5", `GET /amm/pools (the bare host: swap): every enabled token's, each row with its tokenId (${JSON.stringify(b1?.map((p) => `${String(p.tokenId).slice(0, 8)}… ${String(p.outpoint).slice(0, 8)}…`))})`);
  const s1 = sseEvents(`${R}/amm/pools`);
  const first1 = await until("the first /amm/pools event", () => s1.got[0], 15_000) as unknown[] | undefined;
  check(Array.isArray(first1) && first1.length === 1, `GET /amm/pools as an event stream: the first event (${first1?.length ?? "none"} pool)`);

  // ------------------------------------------------ disable, enable again
  await send({ fn: "disable", args: { tokenId: A } });
  const off = await until("A stopped", async () => (await get(`/@${A}/amm/token`)).status === 404 ? true : undefined);
  await x.exchange.idle();
  check(!!off && x.db.get(A)?.status === "disabled" && (await getJson(`/@${SWAP}/amm/tokens`))[0].status === "disabled", "disable: swap's row disabled; the instance stopped (404 at /@<A>)");
  const after1 = await until("/amm/pools without A", () => s1.got.length >= 2 && Array.isArray(s1.got.at(-1)) && (s1.got.at(-1) as unknown[]).length === 0 ? true : undefined, 15_000);
  check(!!after1, `…the /amm/pools stream after the disable: sent again, A's pools gone (${s1.got.length} events)`);
  await s1.close();
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
  { const t = await get(`/@${DISCOVERY}/1color/tokens`); check(t.status === 200 && Array.isArray(JSON.parse(t.text)), `discovery: GET /@discovery/1color/tokens ${t.status} (P13)`); }
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
