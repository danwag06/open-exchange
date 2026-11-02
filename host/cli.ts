// `open-exchange`: the Open Exchange host (shruggr/open-exchange#1) — skein's host (`skein-host run`,
// the same settings: $SKEIN_HOME/host.env under the environment) plus the Open Exchange's wiring of
// the events its `swap` instance emits (shruggr/skein#164; exchange.ts).
//
//   open-exchange run                    the host: skein-host run's router, ports, libp2p node, chain feed,
//                                        Arcade, pages; swap's events wired; at start the packaged swap
//                                        app installed into swap when its version differs (the host's key
//                                        is root there), then the instances reconciled with swap's heads
//   open-exchange setup                  once, with the host stopped: the one key and host.env (when
//                                        absent), the host skein (skein-host init's), then `swap` from the
//                                        image swap, and `discovery` from the image discovery, both owned
//                                        by the host's key (the first wallet to claim swap on Settings
//                                        becomes its admin: amm.admin, not root); discovery's topic
//                                        tm_color and lookup ls_color registered by root's messages.
//                                        Again: a no-op where things exist
//
// Open Exchange runs ONE key (skein#160, SKEIN_KEY_FILE): it owns every instance it makes, swap too (0.5.0;
// David: "The host is the host … The user can issue commands that the host trusts"). Its images are
// this repository's image/ (SKEIN_IMAGES_DIR is set to it).
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Exchange, DISCOVERY, DISCOVERY_TOPICS, SWAP } from "./exchange.ts";
import { IMAGES_DIR, load, skeinVersion, type Skein } from "./skein.ts";

type Vars = Record<string, string | undefined>;
export interface Env { vars: Vars; out(l: string): void; err(l: string): void }

const USAGE = `usage:
  open-exchange run                     the host (skein-host run's) with swap's events wired; reconciled with swap at start
  open-exchange setup                   once, host stopped: key + host.env if absent, the host skein, swap and discovery (both
                                        owned by the host's key; the first wallet to claim swap on Settings becomes its admin),
                                        discovery's tm_color / ls_color registered
settings: $SKEIN_HOME/host.env (every SKEIN_* line; the environment wins), as skein-host's`;

/** The settings, host.env under the environment, with this repository's images. */
export function settings(sk: Skein, given: Env): Env {
  const vars = sk.hostenv.withHostEnv(given.vars);
  if (vars.SKEIN_IMAGES_DIR && vars.SKEIN_IMAGES_DIR !== IMAGES_DIR) given.out(`open-exchange: SKEIN_IMAGES_DIR ${vars.SKEIN_IMAGES_DIR} → ${IMAGES_DIR} (Open Exchange's images are its own)`);
  vars.SKEIN_IMAGES_DIR = IMAGES_DIR;
  return { ...given, vars };
}

/** The host's key: one-key mode only (its identity owns every instance; its wallet signs root's messages). */
function hostKey(sk: Skein, vars: Vars) {
  if (!sk.signer.oneKeySetting(vars)) throw new Error("Open Exchange runs one key: set SKEIN_KEY_FILE in host.env (open-exchange setup makes it)");
  const signer = sk.signer.signerOf(vars, sk.hostenv.homeOf(vars));
  return { identity: signer.identity(""), wallet: signer.wallet("") };
}

export async function main(argv: string[], given: Env): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") { given.out(USAGE); return cmd ? 0 : 2; }
  const sk = await load();
  if (cmd === "run") return await run(sk, settings(sk, given), rest);
  if (cmd === "setup") return await setup(sk, given, rest);
  given.err(USAGE);
  return 2;
}

// ---------------------------------------------------------------- run

export interface Running { host: Awaited<ReturnType<Skein["cli"]["runHost"]>>; exchange: Exchange; db: InstanceType<Skein["instances"]["HostDb"]>; stop(): Promise<void> }

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
  const host = await sk.cli.runHost(db, env, { router: { ...o.router, appEvent: (h: string, rec: Record<string, unknown>) => { if (ex) ex.event(h, rec); else early.push([h, rec]); } } });
  ex = new Exchange({ sk, router: host.router, hostKey: key.identity, hostWallet: key.wallet, log: (l) => env.out(`[open-exchange] ${l}`), ...(o.swapAppDir ? { swapAppDir: o.swapAppDir } : {}) });
  env.out(`open-exchange: swap's events wired (token-enabled, token-disabled, discovery-on, discovery-off, claimed) · skein ${skeinVersion()} · images ${IMAGES_DIR} · the host's key ${key.identity.slice(0, 8)}…`);
  for (const [h, rec] of early.splice(0)) ex.event(h, rec);
  void ex.updateSwap();
  void ex.reconcile();
  const exchange = ex;
  return { host, exchange, db, stop: async () => { await exchange.idle(); await host.stop(); db.close(); } };
}

async function run(sk: Skein, env: Env, rest: string[]): Promise<number> {
  if (rest.length) { env.err(USAGE); return 2; }
  let x: Running;
  try { x = await startExchange(sk, env); } catch (e) { env.err(`open-exchange: ${(e as Error).message}`); return 2; }
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

// ---------------------------------------------------------------- setup

/** The exchange's network for now (skein#156: its headers come from that network's Teranode mesh and data hub). */
export const NETWORK = "test";
/** The overlay's libp2p bootstrap peer (the swap.skein.nexus node), baked in until discovery has defaults. */
export const OVERLAY_BOOTSTRAP = "/ip4/100.101.206.71/tcp/4001/p2p/16Uiu2HAmVaxF2a3HnwRUHyEL8XCg92E5Hx9voSjb13tABcpdg1bo";

/**
 * The host.env a new Open Exchange starts from (when there is none): one key, the host's one SQLite
 * database (every instance a set of it, run by the wasm kernel skein's host loads: the settled split),
 * swap at the root, the network and the overlay's bootstrap peer. No headers setting: the host follows
 * the network's Teranode mesh and syncs the chain from its data hub on the first run (skein#156).
 */
function defaultHostEnv(home: string): string {
  return [
    "# Open Exchange host settings (open-exchange setup). Every SKEIN_* line; the environment wins.",
    `SKEIN_KEY_FILE=${join(home, "key")}`,
    `SKEIN_STORE_SQLITE=${join(home, "store.sqlite")}`,
    `SKEIN_ROOT_INSTANCE=${SWAP}`,
    `SKEIN_NETWORK=${NETWORK}`,
    "# The overlay's bootstrap peer (swap.skein.nexus): baked in until discovery has defaults.",
    `SKEIN_LIBP2P_BOOTSTRAP=${OVERLAY_BOOTSTRAP}`,
    "",
  ].join("\n");
}

export async function setup(sk: Skein, given: Env, rest: string[]): Promise<number> {
  let positionals: string[];
  try { ({ positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} })); } catch (e) { given.err(`open-exchange setup: ${(e as Error).message} (no --admin since 0.3.0: the first wallet to claim swap on Settings becomes its admin)`); given.err(USAGE); return 2; }
  if (positionals.length) { given.err(USAGE); return 2; }
  const home = sk.hostenv.homeOf(given.vars);
  mkdirSync(home, { recursive: true });
  // host.env and the one key, when absent (never overwritten).
  const envFile = join(home, sk.hostenv.HOST_ENV);
  if (!existsSync(envFile)) { writeFileSync(envFile, defaultHostEnv(home), { mode: 0o600 }); given.out(`open-exchange setup: ${envFile} written (one key, the host's SQLite database, swap at the root, network ${NETWORK}, the overlay's bootstrap peer)`); }
  const env = settings(sk, given);
  const keyFile = env.vars.SKEIN_KEY_FILE;
  if (keyFile && !existsSync(keyFile)) {
    writeFileSync(keyFile, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    given.out(`open-exchange setup: the host's key made at ${keyFile} (mode 0600)`);
  }
  let key;
  try { key = hostKey(sk, env.vars); } catch (e) { env.err(`open-exchange setup: ${(e as Error).message}`); return 2; }
  if (existsSync(join(home, sk.control.CONTROL_SOCKET))) {
    const alive = await sk.control.controlRequest(join(home, sk.control.CONTROL_SOCKET), { op: "ping" } as never, 5000).then((a) => a !== undefined, () => false);
    if (alive) { env.err("open-exchange setup: the host is running (its control socket answers): stop it first"); return 1; }
  }
  const db = new sk.instances.HostDb(join(home, "host.db"));
  // The headers tracker stays off here: setup only makes instances; `run` syncs the chain (and fills theirs).
  const host = await sk.cli.runHost(db, { ...env, vars: { ...env.vars, SKEIN_TERANODE: "off" } }, { router: { cron: false } });
  const r = host.router;
  const ex = new Exchange({ sk, router: r, hostKey: key.identity, hostWallet: key.wallet, log: (l) => env.out(`[open-exchange] ${l}`) });
  const made: string[] = [];
  try {
    // swap: the Settings and Swap pages, the admin's decisions (image swap), born owned by the host's key (0.5.0):
    // the host can always update its pages; the first wallet to claim it (the app's box amm/claim) is granted amm.admin.
    if (!db.get(SWAP)) {
      const c = await r.createInstance(SWAP, key.identity, { image: "swap", owned: true });
      made.push(`${SWAP} ${c.url} (owned by the host's key)`);
      // Born owned, swap boots and steps at once: let it settle before discovery's genesis is written
      // (the host's one SQLite database: a kernel worker opening it beside a large write can find it locked).
      await r.settled();
      await (await r.hydrate(SWAP)).kernel.idle().catch(() => {});
    }
    else env.out(`open-exchange setup: ${SWAP} exists (${db.get(SWAP)!.status})`);
    // discovery: the 1Color discovery topic (image discovery), born owned, routed by tm_color and ls_color.
    if (!db.get(DISCOVERY)) { const c = await r.createInstance(DISCOVERY, key.identity, { image: "discovery", owned: true, topics: DISCOVERY_TOPICS }); made.push(`${DISCOVERY} ${c.url}`); }
    else env.out(`open-exchange setup: ${DISCOVERY} exists (${db.get(DISCOVERY)!.status})`);
    if (db.get(DISCOVERY)!.status === "enabled") {
      const read = async (p: string) => { const x = await r.dispatch({ method: "GET", url: `${r.origin()}/@${DISCOVERY}/1color/${p}`, headers: {}, body: new Uint8Array() }); return x.status === 200 ? JSON.parse(new TextDecoder().decode(x.body)) as Record<string, unknown> : {}; };
      if (!("tm_color" in await read("listTopicManagers"))) { await ex.rootMessage(DISCOVERY, "1color/register", { fn: "register", args: { topic: "tm_color", program: "color-topic" } }); made.push(`${DISCOVERY}: tm_color registered (color-topic)`); }
      await r.settled();
      if (!("ls_color" in await read("listLookupServiceProviders"))) { await ex.rootMessage(DISCOVERY, "1color/register", { fn: "registerLookup", args: { service: "ls_color", program: "color-lookup", topics: ["tm_color"] } }); made.push(`${DISCOVERY}: ls_color registered (color-lookup over tm_color)`); }
      await r.settled();
      const tm = await read("listTopicManagers"), ls = await read("listLookupServiceProviders");
      env.out(`open-exchange setup: ${DISCOVERY} serves ${Object.keys(tm).join(", ") || "no topic"}; lookups ${Object.keys(ls).join(", ") || "none"}`);
    } else env.out(`open-exchange setup: ${DISCOVERY} is stopped (swap's discovery is off): its registrations are left as they are`);
    for (const m of made) env.out(`open-exchange setup: made ${m}`);
    if (!made.length) env.out("open-exchange setup: nothing to do (everything exists)");
    const adm = await r.dispatch({ method: "GET", url: `${r.origin()}/@${SWAP}/amm/admin`, headers: {}, body: new Uint8Array() });
    const claimant = adm.status === 200 ? (JSON.parse(new TextDecoder().decode(adm.body)) as { claimant?: string }).claimant : undefined;
    env.out(`open-exchange setup: ${SWAP}: ${claimant ? `claimed — its admin is ${claimant}` : adm.status === 200 ? "unclaimed — the first wallet to claim it on Settings becomes its admin" : `no /admin read (${adm.status}): its pages are older than this package's (run updates them where the host's key is root)`}`);
    env.out(`open-exchange setup: done · the host's key ${key.identity} owns ${(await ex.holders(SWAP, "root")).includes(key.identity) ? `${SWAP} and ` : ""}${DISCOVERY} · run: open-exchange run`);
    return 0;
  } catch (e) {
    env.err(`open-exchange setup: ${(e as Error).stack ?? e}`);
    return 1;
  } finally {
    await host.stop();
    db.close();
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), { vars: process.env, out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) });
  if (process.argv[2] === "setup") process.exit(process.exitCode);
}
