# Open Exchange

The Open Exchange is a distributable application host for 1Color token swaps. It runs on
[skein](https://github.com/shruggr/skein)'s host, used as a library. The AMM itself is a
library, [skein-amm](https://github.com/shruggr/skein-amm): the token app, its programs and
the page library. Open Exchange adds the host program, the `swap` app and the images.

## Run it

```
npx open-exchange
```

Then open http://127.0.0.1:8100, connect your wallet (Yours) and claim the exchange on Settings.

Nothing needs setting. The first start takes a few minutes: it syncs the block headers. The design is in shruggr/open-exchange#1 and shruggr/skein#164.

## The shape

- **swap**: the instance that serves the Swap, Liquidity, Your tokens and Settings pages.
  - It records the admin's decisions as facts under its own heads.
  - It emits each fact as an event.
  - It asks nothing of anyone, and nothing answers back.
  - The first run makes it, born owned by the host's key (root): the host can always update its
    pages. The first wallet to claim it (Settings: "Claim this exchange") becomes its ADMIN:
    the host grants it the role `amm.admin`, which configures and enables; it is not root.
    Someone else got there first: start again in a fresh `SKEIN_HOME`.
- **The host** (`open-exchange`, the same as `open-exchange run`): skein's host, `skein-host run`, plus its wiring for
  swap's events.
- **The token instances**: one per enabled token, at `<origin>/@<tokenId>`.
  - Each comes from the image `token`, which installs skein-amm's token app.
  - Each is born owned by the host's key: no claim.
  - Each takes its deploy BEEF as an event on the token app's route.
- **discovery**: the 1Color discovery topic `tm_color` and its lookup `ls_color`.
  - It comes from the image `discovery`, which installs skein-1color.
  - The first run makes it, born owned by the host's key: no claim.
  - The Settings switch only starts and stops it.

## The events (swap's app `amm`, box `amm/admin`, the admin's or root's messages)

The box `amm/admin` is gated by the role `amm.admin` (its route's function `configure`); root
passes anything, so the host's key may send these too.

| message | swap records | event | the host |
|---|---|---|---|
| `enable {tokenId, beef?}` | row `enabled` under `amm/tokens`, the BEEF kept | `token-enabled {tokenId, beef, terms?, market?}` | see below |
| `disable {tokenId}` | row `disabled` | `token-disabled {tokenId}` | stops the instance (disabled; off its libp2p node); never removes it |
| `discovery {on}` | `{on, since}` under `amm/discovery` | `discovery-on` / `discovery-off` | starts / stops `discovery` |
| `defaults {terms?, market?}` | `amm/defaults` | none | the next `token-enabled` events carry them |
| `claim` (box `amm/claim`, any sender; the first only) | `{claimant, since}` under `amm/claim` (read: `GET <swap>/amm/admin`) | `claimed {claimant}` | grants `amm.admin` on swap to the claimant (root's `grant`) |

When `token-enabled` names a token that has no instance yet, the host:

1. Creates the instance `<tokenId>` from the image `token`, disabled.
2. Records its names `[tm_color_<id>, ls_color_<id>, ls_amm_<id>]` for routing.
3. Feeds in the deploy as `{kind: "deploy", beef}` in `amm/deploy`. The door checks the BEEF.
4. If the deploy is admitted, publishes the instance.
5. Sends `terms` into `amm/validator` and `market` into `amm/amm-p2p`, each as root's
   message signed by the host's key.

If the door refuses the deploy:

- **A file store**: the instance is removed.
- **A set** (the host's SQLite database, RocksDB or LMDB): the instance is left disabled,
  because a set cannot be removed.

When `token-enabled` names a token whose instance exists:

- **A stopped instance**: it is started.
- **An instance with no token**: its deploy is fed in.

Every reaction is idempotent and logged.

**At start**, the host reconciles the host's instance table with swap's heads:

- `/amm/tokens`:
  - `enabled` means the instance is made running.
  - An enabled token with no instance is created. Its BEEF is read from swap's last
    `token-enabled` event in swap's log.
  - `disabled` means the instance is stopped.
- `/amm/discovery`: on means `discovery` is started; off means it is stopped.

Reads on swap (anyone):

- `/amm/tokens`: `[{tokenId, topic, sym, dec, icon?, status, since}]`
- `/amm/defaults`
- `/amm/discovery`: `{on, since}`
- `/`: the pages

## Requirements

- **Node 24 or later**, on any platform node runs on. Nothing else: no toolchain.
- **skein 0.2.5**, the npm dependency (`package.json`). Its host is built to JavaScript, and its
  kernel is one wasm file the host loads: one machine per active instance on a worker thread,
  every instance a set of the host's one SQLite database (`SKEIN_STORE_SQLITE`, the default
  the first run writes). A host.env naming `SKEIN_STORE_ROCKSDB` runs skein's native kernel process
  instead; that needs a skein checkout with its kernel built (the hosted shape).
- **One key** (skein#160): `SKEIN_KEY_FILE`. It owns every instance Open Exchange makes, swap
  included; the wallet that claims swap is its admin.
- **The images**: this repository's `image/`. Open Exchange sets `SKEIN_IMAGES_DIR` to it.

## The first run

`npx open-exchange` (no arguments: `run`) makes, in `$SKEIN_HOME` (default `~/.skein`), whatever
is missing, then serves:

- `host.env`, if absent, with four settings: the key file (`SKEIN_KEY_FILE`), the host's SQLite
  database (`SKEIN_STORE_SQLITE=$SKEIN_HOME/store.sqlite`, the wasm kernel), swap at the root
  (`SKEIN_ROOT_INSTANCE=swap`), and the network (`SKEIN_NETWORK=test`, or the one in the
  environment at the first run; testnet until mainnet has a hosted exchange).
- The key file, if absent (mode 0600).
- The host skein, as `skein-host init` does.
- `swap` from the image `swap`, owned by the host's key, unclaimed.
- `discovery` from the image `discovery`, with its `tm_color` and `ls_color` registered by
  root's messages.

Everything else is a per-network default in skein's host:

- the overlay's bootstrap peer (testnet: the hosted Open Exchange node);
- the Arcade (testnet: `https://testnet.arcade.1sat.app`). Its callback token is made on the
  first run and appended to `host.env`;
- the headers: the host follows the network's Teranode P2P mesh and syncs the chain from its
  data hub (skein#156). That sync is why the first start takes a few minutes.

A setting you add to `host.env` (another network, a port, a domain, another Arcade) wins over the
default. An existing `host.env` is left as it is. A later run makes nothing that exists.
(`open-exchange setup` is gone since 0.6.0: the first run does it.)

The admin is a claim. Open the pages, connect a wallet and go to Settings. While nobody has
claimed swap, Settings shows the card "Claim this exchange". The wallet that claims it (its
message `{fn: "claim"}` in box `amm/claim`) becomes the admin: the host grants it `amm.admin`,
and it enables tokens and sets terms. It is not root: the host's key stays swap's root. A second
claim is refused. `GET <swap>/amm/admin` answers `{claimant, since}`, or `{}`.

## Upgrade

```
npm install -g open-exchange@latest
```

(or run `npx open-exchange@latest`), then restart the host. At start the host compares the packaged swap app's version
(`apps/swap/etc/app.json`) with the one installed in swap (its head `amm/app`) and, when they
differ, installs the packaged app into swap as the host's key (root), as `skein install` would:
the pages follow the package. A swap made by open-exchange 0.3.0–0.4.5 has no host root (its
root is whoever claimed it): `run` logs a warning and leaves its pages as they are.

`run` takes every setting `skein-host run` takes from `host.env`. It serves everything
`skein-host` serves:

- bare-host routing by topic
- pages
- libp2p
- the chain feed
- Arcade

## Images (`image/<name>/etc/apps.json`, merged over skein's default image)

| image | installs |
|---|---|
| `swap` | skein-chain v0.7.1 (tarball; 0.7.1: a reorg broadcasts nothing), `../../apps/swap` (pages: skein-amm v0.31.1's web/ui); root's route `/` → the pages; created owned by the host's key |
| `token` | skein-chain v0.7.1, skein-amm v0.31.1 (tarballs, by tree hash; 0.31.1: a swap leg refused `pool_spent` is repriced against the pool's newest state and sent once more; 0.31.0: the relay's dialled frame names the token's topic, so a validator whose host runs several instances on one libp2p node gets the stream; 0.29.5: the validator's submission carries the pool's transaction back to proven ones, so the door admits a relayed swap; 0.24.1: skein-overlay 0.20.0 and skein-1color 0.13.1, the settled sync design — announce, then fetch; no wants; every proof published); root's `/submit`, `/lookup` |
| `discovery` | skein-chain v0.7.1, skein-1color v0.13.1 (tarballs; engine skein-overlay 0.20.0); root's `/submit`, `/lookup` |

## Build and test

```
zig build test                      # the swap program's tests
zig build bin                       # apps/swap/bin/config.wasm (committed)
scripts/www.sh                      # apps/swap/www (committed): skein-amm v0.31.1's web/ui + the 1Color pages
npm install --no-save <dcasegr-skein-0.2.5.tgz>   # skein from its `npm pack` until it is published
npm run typecheck                   # host/ and scripts/ against node_modules/@dcasegr/skein
npm run build                       # dist/ (what the package runs; `npm pack` builds it)
[SKEIN_REPLAY_DIR=<skein checkout>] [SKEIN_EQUIV_STORE=rocksdb|file] [OX_ACCEPT_ZERO=off] npm run accept
```

The acceptance runs on the wasm host by default. `SKEIN_REPLAY_DIR` names a skein checkout with
its native kernel built: every store is then replayed by the native reference. From a package
install: `node node_modules/open-exchange/dist/scripts/accept/ox-accept.js`.

The acceptance (`scripts/accept/ox-accept.ts`) first runs `open-exchange` in a clean
`SKEIN_HOME` with nothing else set, on the real testnet (minutes: the first header sync; port
8100 must be free; `OX_ACCEPT_ZERO=off` skips it): `host.env` holds only the first run's four
settings and a made Arcade token, the log names the testnet Arcade and the overlay bootstrap
node, swap serves, a wallet claims it. Then it uses a scratch regtest host. It walks through
these steps:

1. the first run: swap and discovery owned by the host's key; `/amm/admin` → `{}`; a stranger's message
   in `amm/admin` runs nothing
2. the claim by the admin key: `/amm/admin` names it, the host grants `amm.admin`, root stays
   the host's; a second claim refused
3. run
4. enable: the instance is born, its deploy admitted, its names served, its beats seen, and
   bare-host `/lookup` is routed to it
5. disable, then enable again
6. discovery off, then on
7. a restart, with reconcile
8. swap's pages: a restart with a packaged swap app of another version installs it (as root)
9. a replay of every store
