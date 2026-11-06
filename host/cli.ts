// `open-exchange`: the Open Exchange host (shruggr/open-exchange#1) — skein's host (`skein-host run`,
// the same settings: $SKEIN_HOME/host.env under the environment) plus the Open Exchange's wiring of
// the events its `swap` instance emits (shruggr/skein#164; exchange.ts).
//
//   open-exchange [run]                  the host: skein-host run's router, ports, libp2p node, chain feed,
//                                        Arcade, pages; swap's events wired; at start the packaged swap
//                                        app installed into swap when its version differs (the host's key
//                                        is root there), then the instances reconciled with swap's heads.
//                                        The first run (2026-11-02, zero config: what `setup` did) makes
//                                        what is missing first: the one key and host.env (when absent), the
//                                        host skein, `swap` from the image swap and `discovery` from the
//                                        image discovery, both owned by the host's key (the first wallet to
//                                        claim swap on Settings becomes its admin: amm.admin, not root);
//                                        discovery's topic tm_color and lookup ls_color registered by root's
//                                        messages. Everything else is a per-network default in skein's host
//                                        (the overlay's bootstrap peer, the Arcade and its token)
//
// Open Exchange runs ONE key (skein#160, SKEIN_KEY_FILE): it owns every instance it makes, swap too (0.5.0;
// David: "The host is the host … The user can issue commands that the host trusts"). Its images are
// this repository's image/ (SKEIN_IMAGES_DIR is set to it).
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Exchange, DISCOVERY, DISCOVERY_TOPICS, SWAP } from "./exchange.ts";
import { Relay } from "./relay.ts";
import { Pools } from "./pools.ts";
import { walletRead } from "./wallet.ts";
import { IMAGES_DIR, load, skeinVersion, type Router, type Skein } from "./skein.ts";

type Vars = Record<string, string | undefined>;
export interface Env { vars: Vars; out(l: string): void; err(l: string): void }

const USAGE = `usage:
  open-exchange [run]                   the host (skein-host run's) with swap's events wired; reconciled with swap at start.
                                        The first run makes what is missing first: the key and host.env, the host skein,
                                        swap and discovery (both owned by the host's key; the first wallet to claim swap
                                        on Settings becomes its admin), discovery's tm_color / ls_color registered
settings: $SKEIN_HOME/host.env (every SKEIN_* line; the environment wins), as skein-host's. Nothing needs setting`;

/** The settings, host.env under the environment, with this repository's images. */
export function settings(sk: Skein, given: Env): Env {
  const vars = sk.hostenv.withHostEnv(given.vars);
  if (vars.SKEIN_IMAGES_DIR && vars.SKEIN_IMAGES_DIR !== IMAGES_DIR) given.out(`open-exchange: SKEIN_IMAGES_DIR ${vars.SKEIN_IMAGES_DIR} → ${IMAGES_DIR} (Open Exchange's images are its own)`);
  vars.SKEIN_IMAGES_DIR = IMAGES_DIR;
  return { ...given, vars };
}

/** The host's key: one-key mode only (its identity owns every instance; its wallet signs root's messages). */
function hostKey(sk: Skein, vars: Vars) {
  if (!sk.signer.oneKeySetting(vars)) throw new Error("Open Exchange runs one key: set SKEIN_KEY_FILE in host.env (the first run writes it into a new host.env)");
  const signer = sk.signer.signerOf(vars, sk.hostenv.homeOf(vars));
  return { identity: signer.identity(""), wallet: signer.wallet("") };
}

export async function main(argv: string[], given: Env): Promise<number> {
  const [cmd = "run", ...rest] = argv;
  if (cmd === "help" || cmd === "-h" || cmd === "--help") { given.out(USAGE); return 0; }
  if (cmd === "setup") { given.err("open-exchange setup: gone since 0.6.0 — `open-exchange` (run) does it on its first run"); return 2; }
  if (cmd !== "run") { given.err(USAGE); return 2; }
  const sk = await load();
  return await run(sk, given, rest);
}

// ---------------------------------------------------------------- run

export interface Running { host: Awaited<ReturnType<Skein["cli"]["runHost"]>>; exchange: Exchange; pools: Pools; relay: Relay; db: InstanceType<Skein["instances"]["HostDb"]>; stop(): Promise<void> }

/**
 * The host (skein-host run's runHost: the same router options from the same settings) with swap's
 * events wired to the reactions, and the instances reconciled with swap's heads (not awaited here:
 * `exchange.idle()`). `router` options beyond the settings and `swapAppDir`: tests'.
 */
export async function startExchange(sk: Skein, env: Env, o: { router?: Record<string, unknown>; swapAppDir?: string } = {}): Promise<Running> {
  const home = sk.hostenv.homeOf(env.vars);
  const key = hostKey(sk, env.vars);
  mkdirSync(home, { recursive: true });
  const db = new sk.instances.HostDb(join(home, "host.db"));
  // Events handed over before the reactions exist (a kernel's start) wait for them.
  let ex: Exchange | undefined;
  const early: Array<[string, Record<string, unknown>]> = [];
  // 0.11.0: the pool reads (pools.ts) — GET /amm/pools and /@<tokenId>/amm/pools, the host's (skein's appRead);
  // 0.13.0: GET /amm/stats and /amm/positions too; 0.14.0: /amm/spends, the market candles and the pool event
  // feeds (a token instance's emitted `pool` event goes to the feeds, not to swap's reactions).
  let pools: Pools | undefined;
  // 0.15.0: GET /amm/wallet and /amm/wallet/tx (wallet.ts), the host's reads of swap's core wallet and its withdrawals.
  let walletHost: Router | undefined;
  // 0.17.0 (skein-amm 0.44.0): POST /@<tokenId>/amm/swap, the swap relay (relay.ts), the request's close its only timer.
  // PENDING (skein): the Router hands an application host GETs only (`appRead`) and a request carries no close
  // signal, so this route is not reached on skein 0.3.1; `req.signal` is the close signal it needs.
  let relay: Relay | undefined;
  const appRead = async (h: string, route: string, url: URL, req: Parameters<Pools["appRead"]>[3]) =>
    (await relay?.route(h, route, req, (req as { signal?: AbortSignal }).signal)) ??
    (walletHost ? await walletRead(sk, walletHost, SWAP, h, route, url) : undefined) ?? await pools?.appRead(h, route, url, req);
  const appEvent = (h: string, rec: Record<string, unknown>) => {
    if (pools?.poolEvent(h, rec)) return;
    if (ex) ex.event(h, rec); else early.push([h, rec]);
  };
  const host = await sk.cli.runHost(db, env, { router: { ...o.router, appRead, appEvent } });
  const log = (l: string) => env.out(`[open-exchange] ${l}`);
  pools = new Pools(host.router, log, sk.cid.decode);
  relay = new Relay({ router: host.router, sk, log });
  walletHost = host.router;
  const pl = pools;
  ex = new Exchange({ sk, router: host.router, hostKey: key.identity, hostWallet: key.wallet, log, ...(o.swapAppDir ? { swapAppDir: o.swapAppDir } : {}) });
  env.out(`open-exchange: swap's events wired (token-enabled, token-disabled, discovery-on, discovery-off, claimed) · skein ${skeinVersion()} · images ${IMAGES_DIR} · the host's key ${key.identity.slice(0, 8)}…`);
  for (const [h, rec] of early.splice(0)) ex.event(h, rec);
  void ex.updateSwap();
  void ex.reconcile();
  const exchange = ex;
  return { host, exchange, pools: pl, relay: relay!, db, stop: async () => { await exchange.idle(); pl.stop(); await host.stop(); db.close(); } };
}

async function run(sk: Skein, given: Env, rest: string[]): Promise<number> {
  if (rest.length) { given.err(USAGE); return 2; }
  let first: FirstRun;
  try { first = await firstRun(sk, given); } catch (e) { given.err(`open-exchange: ${(e as Error).message}`); return 1; }
  if (first.failed) return 1;
  const env = settings(sk, given);
  let x: Running;
  try { x = await startExchange(sk, env); } catch (e) { env.err(`open-exchange: ${(e as Error).message}`); return 2; }
  if (first.made.length) {
    const port = x.host.messagebox;
    env.out(`open-exchange: ready — open ${port !== undefined ? `http://127.0.0.1:${port}/` : "this host's router (it did not listen: see above)"}, connect your wallet (Yours), and claim this exchange on Settings`);
  }
  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    env.out(`${sig}: stopping`);
    await x.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  return 0;
}

// ---------------------------------------------------------------- the first run (what `setup` did until 0.6.0)

/**
 * The exchange's network for now (skein#156: its headers come from that network's Teranode mesh and data hub):
 * written into a new host.env unless SKEIN_NETWORK is in the environment at the first run. Mainnet has no
 * hosted exchange and no overlay bootstrap peer yet, so a new install is a testnet one (David to review: drop
 * it, and let skein's default network stand, once mainnet has them).
 */
export const NETWORK = "test";

/**
 * The host.env a new Open Exchange starts from (when there is none): one key, the host's one SQLite
 * database (every instance a set of it, run by the wasm kernel skein's host loads: the settled split),
 * swap at the root, and the network. Nothing else: the overlay's bootstrap peer, the Arcade and its token
 * are the network's defaults in skein's host (0.2.5; the token is made on the first run and appended here);
 * the host follows the network's Teranode mesh and syncs the chain from its data hub (skein#156).
 */
function defaultHostEnv(home: string, network: string): string {
  return [
    "# Open Exchange host settings, made on the first run. Every SKEIN_* line; the environment wins.",
    `SKEIN_KEY_FILE=${join(home, "key")}`,
    `SKEIN_STORE_SQLITE=${join(home, "store.sqlite")}`,
    `SKEIN_ROOT_INSTANCE=${SWAP}`,
    "# Testnet until mainnet has a hosted exchange to bootstrap from.",
    `SKEIN_NETWORK=${network}`,
    "",
  ].join("\n");
}

export interface FirstRun { made: string[]; failed?: boolean }

/**
 * What a new home lacks, made before the host serves (the first run; a no-op where everything exists):
 * host.env and the one key when absent (never overwritten), then — only when swap or discovery is
 * missing — a short host of its own (the headers tracker and cron off: it only makes
 * instances, as `setup` did; its runHost makes the host skein, as every start lacking one does) that makes
 * them, owned by the host's key, registers discovery's names, and stops. Its log is kept to a few lines; errors are said.
 */
export async function firstRun(sk: Skein, given: Env): Promise<FirstRun> {
  const home = sk.hostenv.homeOf(given.vars);
  const made: string[] = [];
  mkdirSync(home, { recursive: true });
  const envFile = join(home, sk.hostenv.HOST_ENV);
  if (!existsSync(envFile)) {
    const network = given.vars.SKEIN_NETWORK || NETWORK;
    writeFileSync(envFile, defaultHostEnv(home, network), { mode: 0o600 });
    made.push(`settings ${envFile} (network ${network})`);
  }
  const env = settings(sk, { ...given, out: () => {} });
  const keyFile = env.vars.SKEIN_KEY_FILE;
  if (keyFile && !existsSync(keyFile)) {
    writeFileSync(keyFile, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    made.push(`the host's key ${keyFile} (mode 0600)`);
  }
  const key = hostKey(sk, env.vars);
  const say = (l: string) => given.out(`open-exchange: ${l}`);
  {
    const db = new sk.instances.HostDb(join(home, "host.db"));
    const missing = !db.get(SWAP) || !db.get(DISCOVERY); // the host skein: runHost makes it on any start that lacks it
    db.close();
    if (!missing) {
      for (const m of made) say(`made ${m}`);
      return { made };
    }
  }
  say(`first run in ${home}: making the exchange (the host's key ${key.identity})`);
  for (const m of made) say(`made ${m}`);
  if (existsSync(join(home, sk.control.CONTROL_SOCKET))) {
    const alive = await sk.control.controlRequest(join(home, sk.control.CONTROL_SOCKET), { op: "ping" } as never, 5000).then((a) => a !== undefined, () => false);
    if (alive) { given.err("open-exchange: a host is running in this SKEIN_HOME (its control socket answers): stop it first"); return { made, failed: true }; }
  }
  const db = new sk.instances.HostDb(join(home, "host.db"));
  // The headers tracker stays off here: this host only makes instances; the run after it syncs the chain (and fills theirs).
  // Its own log is not shown (the run that follows prints the host's); its errors are.
  const quiet: Env = { ...env, out: (l) => { if (/Arcade callback token made/.test(l)) given.out(l); }, err: given.err };
  const host = await sk.cli.runHost(db, { ...quiet, vars: { ...env.vars, SKEIN_TERANODE: "off" } }, { router: { cron: false } });
  const r = host.router;
  const ex = new Exchange({ sk, router: r, hostKey: key.identity, hostWallet: key.wallet, log: () => {} });
  try {
    // swap: the Settings and Swap pages, the admin's decisions (image swap), born owned by the host's key (0.5.0):
    // the host can always update its pages; the first wallet to claim it (the app's box amm/claim) is granted amm.admin.
    if (!db.get(SWAP)) {
      await r.createInstance(SWAP, key.identity, { image: "swap", owned: true });
      made.push(`${SWAP} (the pages; owned by the host's key, unclaimed)`);
      // Born owned, swap boots and steps at once: let it settle before discovery's genesis is written
      // (the host's one SQLite database: a kernel worker opening it beside a large write can find it locked).
      await r.settled();
      await (await r.hydrate(SWAP)).kernel.idle().catch(() => {});
    }
    // discovery: the 1Color discovery topic (image discovery), born owned, routed by tm_color and ls_color.
    if (!db.get(DISCOVERY)) { await r.createInstance(DISCOVERY, key.identity, { image: "discovery", owned: true, topics: DISCOVERY_TOPICS }); made.push(`${DISCOVERY} (owned by the host's key)`); }
    if (db.get(DISCOVERY)!.status === "enabled") {
      const read = async (p: string) => { const x = await r.dispatch({ method: "GET", url: `${r.origin()}/@${DISCOVERY}/1color/${p}`, headers: {}, body: new Uint8Array() }); return x.status === 200 ? JSON.parse(new TextDecoder().decode(x.body)) as Record<string, unknown> : {}; };
      if (!("tm_color" in await read("listTopicManagers"))) await ex.rootMessage(DISCOVERY, "1color/register", { fn: "register", args: { topic: "tm_color", program: "color-topic" } });
      await r.settled();
      if (!("ls_color" in await read("listLookupServiceProviders"))) await ex.rootMessage(DISCOVERY, "1color/register", { fn: "registerLookup", args: { service: "ls_color", program: "color-lookup", topics: ["tm_color"] } });
      await r.settled();
      const tm = await read("listTopicManagers"), ls = await read("listLookupServiceProviders");
      made.push(`${DISCOVERY}'s ${[...Object.keys(tm), ...Object.keys(ls)].join(" and ") || "nothing"} registered`);
    }
    say(`made ${made.filter((m) => !m.startsWith("settings") && !m.startsWith("the host's key")).join(", ")}`);
    return { made };
  } catch (e) {
    given.err(`open-exchange: the first run: ${(e as Error).stack ?? e}`);
    return { made, failed: true };
  } finally {
    await host.stop();
    db.close();
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), { vars: process.env, out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) });
}
