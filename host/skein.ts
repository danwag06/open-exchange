// The skein host as a library (shruggr/skein#164; the settled split, 2026-10-31): Open Exchange runs on
// skein's host, the npm package `@dcasegr/skein` (a dependency by version). The package ships its host built to
// JavaScript (dist/) and the kernel as one wasm file, so nothing here needs a toolchain or a checkout.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** This package's root: the nearest directory up from here whose package.json is open-exchange's (host/ in a checkout, dist/host/ built). */
function rootOf(from: string): string {
  for (let d = from; ; d = dirname(d)) {
    const p = join(d, "package.json");
    if (existsSync(p) && (JSON.parse(readFileSync(p, "utf8")) as { name?: string }).name === "open-exchange") return d;
    if (dirname(d) === d) throw new Error(`open-exchange: no package root above ${from}`);
  }
}
export const OX_ROOT = rootOf(dirname(fileURLToPath(import.meta.url)));
/** The images Open Exchange creates its instances from (swap, token, discovery). */
export const IMAGES_DIR = join(OX_ROOT, "image");
/** The swap app as packaged (the image swap installs it from here; `run` installs a newer one into swap). */
export const SWAP_APP_DIR = join(OX_ROOT, "apps", "swap");
/** The packaged swap app's version (its etc/app.json). */
export function swapAppVersion(dir = SWAP_APP_DIR): string {
  return (JSON.parse(readFileSync(join(dir, "etc", "app.json"), "utf8")) as { version: string }).version;
}

/** A module of the skein package, by its source path there (`src/host/cli.ts` → `@dcasegr/skein/dist/host/cli.js`). */
export async function skein<T>(rel: string): Promise<T> {
  const m = /^src\/(.+)\.ts$/.exec(rel);
  if (!m) throw new Error(`skein module ${rel}: a path under src/, a .ts file`);
  return await import(`@dcasegr/skein/dist/${m[1]}.js`) as T;
}

/** The skein package's version (for the log). */
export function skeinVersion(): string {
  try { return (JSON.parse(readFileSync(fileURLToPath(import.meta.resolve("@dcasegr/skein/package.json")), "utf8")) as { version: string }).version; } catch { return "?"; }
}

export type Cli = typeof import("@dcasegr/skein/dist/host/cli.js");
export type RouterMod = typeof import("@dcasegr/skein/dist/host/router.js");
export type Router = import("@dcasegr/skein/dist/host/router.js").Router;
export type HostDb = import("@dcasegr/skein/dist/host/instances.js").HostDb;
export type InstancesMod = typeof import("@dcasegr/skein/dist/host/instances.js");
export type HostEnvMod = typeof import("@dcasegr/skein/dist/host/hostenv.js");
export type SignerMod = typeof import("@dcasegr/skein/dist/host/signer.js");
export type RawMod = typeof import("@dcasegr/skein/dist/client/raw.js");
export type CidMod = typeof import("@dcasegr/skein/dist/runtime/cid.js");
export type DoorMod = typeof import("@dcasegr/skein/dist/host/door-answer.js");
export type StoresMod = typeof import("@dcasegr/skein/dist/host/stores.js");
export type IndexStoreMod = typeof import("@dcasegr/skein/dist/runtime/index-store.js");
export type P2PMod = typeof import("@dcasegr/skein/dist/host/p2p.js");
export type ControlMod = typeof import("@dcasegr/skein/dist/host/control.js");
export type AdminMod = typeof import("@dcasegr/skein/dist/client/admin.js");
export type InstallMod = typeof import("@dcasegr/skein/dist/host/install.js");
export type BootMod = typeof import("@dcasegr/skein/dist/host/boot.js");

/** The skein modules the host uses, loaded once. */
export async function load() {
  const [cli, routerMod, instances, hostenv, signer, raw, cid, door, stores, indexStore, p2p, control, admin, install, boot] = await Promise.all([
    skein<Cli>("src/host/cli.ts"), skein<RouterMod>("src/host/router.ts"), skein<InstancesMod>("src/host/instances.ts"),
    skein<HostEnvMod>("src/host/hostenv.ts"), skein<SignerMod>("src/host/signer.ts"), skein<RawMod>("src/client/raw.ts"),
    skein<CidMod>("src/runtime/cid.ts"), skein<DoorMod>("src/host/door-answer.ts"), skein<StoresMod>("src/host/stores.ts"),
    skein<IndexStoreMod>("src/runtime/index-store.ts"), skein<P2PMod>("src/host/p2p.ts"), skein<ControlMod>("src/host/control.ts"),
    skein<AdminMod>("src/client/admin.ts"), skein<InstallMod>("src/host/install.ts"), skein<BootMod>("src/host/boot.ts"),
  ]);
  return { cli, routerMod, instances, hostenv, signer, raw, cid, door, stores, indexStore, p2p, control, admin, install, boot };
}
export type Skein = Awaited<ReturnType<typeof load>>;
