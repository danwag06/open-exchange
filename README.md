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

The public read API is documented at `<origin>/api/` (the reference page) and `<origin>/api/openapi.json` (OpenAPI 3.1; sources in `api/`, copied into the pages by `scripts/www.sh`).

The read API's routes, plain GETs, and the pool event feeds (0.14.0: every pool read by the pool id — the deploy outpoint `<txid>_<vout>`, a clean break, no `?lp=`; one price; the validator's minimum leg; the pools route no longer streams):

| route | answer |
|---|---|
| `/amm/pools` | every enabled token's live pools, one array (a plain read) |
| `/amm/stats` (`?ids=`) | every enabled token's `/stats` as the host answers it, one array (the landing page reads it once per load and every 30 s while visible) |
| `/amm/positions?pool=` | every enabled token's positions for the pool ids, each with its `tokenId` |
| `/amm/spends?outpoint=a,b` | one record per outpoint, `{outpoint, tokenId?, spentBy?}`: each enabled token's `/spends`, the first that names a spender |
| `/amm/events` | Server-Sent Events, every enabled token's pool events: `event: pool`, `data: {tokenId, …row}` — the token instance's lookup's row as it admits a deploy, swap, close or rescind (or a `revert` of a rejected one), passed through; nothing on connect, nothing kept, nothing replayed |
| `/@<token>/amm/events` | the same feed for one token |
| `/@<token>/amm/pools` | the token's live pools (each with `poolId`, `lpPubKey`, `swaps`), its market, the validators beating (each with `minLegSats` when its beat's terms carry one); a plain read only |
| `/@<token>/amm/pools/at?t=` | every pool listed at a time, as it stood then |
| `/@<token>/amm/pools/history` (`?from&to&pool&limit&after`) | the raw pool history (deploy, swap, close, rescind), oldest first, paged forward by `next` |
| `/@<token>/amm/trades` (`?from&to&limit&before&pool`, or `?txid=`) | the token's trade rows, newest first (each with `poolId` and `payoutPkh`) |
| `/@<token>/amm/candles?tf&from&to` (`&series=fill` or `market`) | `fill` (default): one candle per non-empty bucket of trades (the instance's); `market` (the host's): the market price after each pool event, one candle per bucket holding an event |
| `/@<token>/amm/stats` | the host's: `price` = the planner's `priceOf` over the pools `/@<token>/amm/pools` lists (the midpoint of what a buy and a sell of 1% of the pooled sats would pay now), `buyPrice`, `sellPrice`; `change1h` / `change24h` from the same price over the pools listed then (`/pools/at`); `lastTradePrice`, 24 h volume and counts, last trade; TVL and pools over the listed pools |
| `/@<token>/amm/color/<token>/holders` (`?limit&skip`) | the holder count and the balances, largest first |
| `/@<token>/amm/pools/beef?pool=`, `/positions?pool=` | by pool id (0.14.0) |
| `/@<token>/amm/fees/validator`, `/fees/commission`, `/terms` (the validator's `minLegSats`), `/spends`, `/tx`, `/token` | as before (0.11.0; 0.17.0: no swap records, so no swap read) |
| `POST /@<token>/amm/swap` (0.17.0) | the swap relay, the HOST's: body `{funding, swap, pool, validator, peerId}` (DAG-JSON bytes) → the validator's reply as it is (`{ok: true, tx, txid, beef?}` / `{ok: false, reason, detail?, pool?, beef?}`), or `{ok: false, reason: "commission_missing"}` (the one rule the host checks: the commission pays this exchange's key) or `{ok: false, reason: "unreachable", detail}` (any break in the call); plain; nothing recorded; the request's close stops the host (host/relay.ts) |
| `/amm/tokens`, `/@discovery/1color/tokens` (rows with `amount` and `height`), `/<token>`, `/<token>/icon`, `/<token>/deploy` | as before |
| `/@discovery/1color/tokens?q=<text>&after=<tokenId>&limit=` (0.15.1) | search: the tokens whose `sym` starts with `q` (ASCII case-insensitive) or whose `tokenId` starts with it, the same rows and order; `after` = the rows strictly after that token (the last row's id; the answer stays the plain array); an unknown `after`, `after` beside `skip`, `q`/`after` beside `ids` → 400; tokens deployed before 0.15.1 are found by id only until their deploy is admitted again |

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
| `terms {tokenId, terms}` (0.12.0; `terms` the three fees, 0.14.0 with an optional `minLegSats` (sats), or `null`) | nothing (the token instance's `amm/terms` is the record) | `token-terms {tokenId, terms}` | sends root's `terms` to the token's instance (`amm/validator`); not replayed at start |
| `discovery {on}` | `{on, since}` under `amm/discovery` | `discovery-on` / `discovery-off` | starts / stops `discovery` |
| `defaults {terms?, market?}` (0.14.0: `terms` may carry `minLegSats`) | `amm/defaults` | none | the next `token-enabled` events carry them |
| `price {sats \| null}` (0.15.0; the price to enable a token, null: off) | `{sats}` under `amm/enable-price` (read: `enablePriceSats` on `/amm/defaults`; `enable-check` reads it) | none (0.15.3) | nothing |
| `withdraw` (0.15.2; no args) | a standard BRC-29 payment to the message's sender, built by swap's own program: the payee key derived for the admin (a fresh prefix and suffix, counterparty the admin), the instance's wallet launched — `list`, then ONE `createAction` with `noSend` of every spendable coin to that key, the total less the builder's fee (no change); kept under `amm/withdrawals` as `{n, txid, sats, at, outputIndex, derivationPrefix, derivationSuffix, senderIdentityKey}` and the Atomic BEEF, and answered with the same and `tx`. Nothing is broadcast here: the admin's wallet takes the payment in, which puts it on the network | none | nothing |
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

- `/amm/tokens`: `[{tokenId, topic, sym, dec, status, since, iconUrl}]` (0.11.0: `iconUrl` =
  `/@discovery/1color/<tokenId>/icon`; the data-URL `icon` is gone)
- `/amm/defaults`: `{terms?, market?, enablePriceSats}` (0.15.0: `enablePriceSats` null when unset)
- `/amm/discovery`: `{on, since}`
- `/amm/wallet` (0.15.0, the host's read of swap's wallet state, no step): `{sats, outputs, withdrawals: [{n, txid,
  sats, at, outputIndex, derivationPrefix, derivationSuffix, senderIdentityKey}]}` — the coins swap's wallet spends (the
  paid enables' payments), their total and count, and the admin's withdrawals (each a BRC-29 payment handed over unsent)
- `/amm/wallet/tx?n=<n>` (0.15.0): withdrawal n's Atomic BEEF (`application/octet-stream`; 404 when none)
- `/`: the pages

## The paid enable (0.15.3: a BEEF submission)

Any signed sender may enable a token for a fee, when the admin has set a price (`enablePriceSats` on
`/amm/defaults`). The request carries the payment in its body, beside the token's deploy, in ONE BEEF:

    POST <origin>/amm/enable?tokenId=<txid>_<vout>&paymentTxid=<hex>&paymentVout=<n>&derivationPrefix=<base64>&derivationSuffix=<base64>
    Content-Type: application/octet-stream
    body: one BEEF holding the token's deploy transaction and the payment transaction, each with its ancestry

The payment is a standard BRC-29 payment to the exchange: output `paymentVout` of `paymentTxid` pays at least the
price, P2PKH to the key derived with protocol `[2, "3241645161d8"]`, key id `"<prefix> <suffix>"`, counterparty
the exchange's identity key (`GET /.well-known/skein`). The client builds and signs it and does NOT send it: the
exchange's wallet takes it in, which is what sends it on.

The route's filters run before anything is recorded: `kernel.brc104` (signed), `kernel.beef` (the BEEF proven),
then the swap app's `enable-check`, which refuses in this order:

| refusal | status | code |
|---|---|---|
| no price set (the paid enable is off) | 403 | `ERR_PAID_ENABLE_OFF` |
| no `tokenId` | 400 | `ERR_BAD_REQUEST` |
| the token is enabled already | 409 | `ERR_TOKEN_ENABLED` |
| the token was disabled by the admin (only the admin enables it again) | 409 | `ERR_TOKEN_DISABLED` |
| the BEEF holds no deploy of that token | 400 | `ERR_BAD_DEPLOY` |
| no payment named, or the named output is not in the BEEF | 402 | `ERR_PAYMENT_REQUIRED` (body `{code, satoshisRequired}`) |
| the output holds less than the price | 402 | `ERR_PAYMENT_TOO_SMALL` (with `satoshisRequired`) |
| the payment transaction is in the exchange's wallet already | 409 | `ERR_PAYMENT_REPLAYED` |

The handler then checks the output pays the BRC-29 key derived for the signed sender (else 400
`ERR_INVALID_PAYMENT`, nothing enabled), hands the payment to swap's wallet (`internalize`, a wallet payment; the
request does not wait for it), enables the token as the admin's enable does (the default terms and market) and keeps
`{paidBy, paymentTxid, satoshisPaid}` on the row; it answers `{fn: "enable", result: <the row>}`. One fee, once;
only the admin disables. `@dcasegr/amm-client`'s `enableToken(tokenId, {deployBeef?})` does all of this.

## Requirements

- **Node 24 or later**, on any platform node runs on. Nothing else: no toolchain.
- **skein 0.2.9**, the npm dependency (`package.json`; 0.2.9: paid routes, `kernel.pay` (not used since 0.15.3); 0.2.8: the host keeps its liveness beats in host.db and reloads them at start, so `/amm/pools` lists pools again right after a restart). Its host is built to JavaScript, and its
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
| `swap` | skein-chain v0.7.1 (tarball; 0.7.1: a reorg broadcasts nothing), `../../apps/swap` (pages: skein-amm v0.43.0's web/ui — 0.43.0: a swap leg refused `pool_spent` whose pool the server still lists at the outpoint it spent leaves that pool out for the rest of the swap; 0.42.3: unchanged (the client's paid enable pays a protected noSend); 0.42.2: unchanged (the client's paid enable); 0.42.1: the withdraw taken in as a wallet payment at once; 0.42.0: Settings' price to enable a token, the exchange's wallet and Withdraw; 0.41.x: Swap reads the pools fresh before each leg and on each pool event, the landing on the `all` feed; 0.40.x: the swap stages what it needs, legs one at a time, by pool id, one price, Settings' Minimum leg (sats); 0.35.0: Settings edits each enabled token's own terms; `/api/` the API docs); root's route `/` → the pages; created owned by the host's key |
| `token` | skein-chain v0.7.1, skein-amm v0.43.0 (tarballs, by tree hash; 0.43.0: the validator signs one swap per pool at a time — a second request for a pool waits until the first settles, then is answered `pool_spent` with the new state (admitted) or signed (rejected); on skein-overlay 0.20.5: a second unmined spender of a coin refused at intake, a submission that applies nothing answered `rejected`; 0.42.3: client only; 0.42.2: client only; 0.42.1: client and pages only; 0.42.0: client and pages only, the programs as 0.41.1; 0.41.1: a `pool_spent` refusal of a closed pool carries the Close's BEEF; 0.41.0: the lookup emits one `pool` event per history row (deploy, swap, close, rescind, revert), the validator's answers carry the BEEF and the relaying host admits it before answering; 0.40.x: token change in the Swap contract, the pool id (the deploy outpoint), the pool history `/pools/at` and `/pools/history`, the validator's `minLegSats`, reads by pool id; 0.39.0: the pages on the token stream's `change` events and the landing on `/amm/stats`, the client's history readers; 0.38.1: on skein-1color 0.15.1, a supply-holding deploy is a value output; 0.38.0: the client packages, pages unchanged; 0.37.0: on skein-1color 0.15.0, the token's holders at `/amm/color/<token>/holders`; 0.36.0: one trade row per admitted swap in `ls_amm_<assetId>` and the history reads `/amm/trades`, `/amm/candles`, `/amm/stats`; 0.35.x: pages only; 0.34.1: the Positions page marks a validator live from `/amm/pools`' `validators`; 0.34.0: the public read API — `/amm/pools/beef`, `/amm/positions`, `/amm/fees/validator`, `/amm/fees/commission`, `/amm/terms`, `/amm/spends` lists, `/amm/tx`, `/amm/swaps`; lookup rows carry `lpPubKey`; 0.33.0: fee rows in `ls_amm_<assetId>`, one per swap admitted from 0.33.0 on (earlier swaps have none), and the list queries `{lpPubKeys}` (each pool's state and LP fees), `{validatorIdentityKeys}`, `{commissionPkhs}`; the Liquidity page loads positions with one query per token; 0.32.0: LP fees per position — `ls_amm_<assetId>` answers `{tokenId, lpPubKey}` with the LP fees a pool lineage earned, sats and tokens apart, and `{tokenId, outpoint}` carries them; the Liquidity page shows them; 0.31.4: the Swap page reads the wallet's sats from the toolbox's balance special operation, not the admin-only `default` basket; 0.31.3: skein-overlay 0.20.2 — `rebeat` re-declares the configured lookups' liveness too; 0.31.2: skein-overlay 0.20.1 — `rebeat` re-declares each topic's liveness window too, so an instance registered before 0.20.0 drops its 40 s window; 0.31.1: a swap leg refused `pool_spent` is repriced against the pool's newest state and sent once more; 0.31.0: the relay's dialled frame names the token's topic, so a validator whose host runs several instances on one libp2p node gets the stream; 0.29.5: the validator's submission carries the pool's transaction back to proven ones, so the door admits a relayed swap; 0.24.1: skein-overlay 0.20.0 and skein-1color 0.13.1, the settled sync design — announce, then fetch; no wants; every proof published); root's `/submit`, `/lookup` |
| `discovery` | skein-chain v0.7.1, skein-1color v0.16.1 (tarballs; 0.16.1: a re-pin on skein-overlay 0.20.5 — one held spender per coin, a truthful answer; 0.16.0: the token list's search and cursor, `/1color/tokens?q=` (symbol or token id STARTS WITH, indexed) and `?after=<tokenId>`; 0.15.3 and 0.15.2: re-pins on skein-sdk 0.13.0 / skein-overlay 0.20.4; 0.15.1: a deploy is filed by what it holds — a supply-holding deploy a value output, an authority-only deploy an authority; 0.15.0: the per-token balance table and `/1color/<token>/holders`, the token rows' `amount` and `height`; 0.14.0: the read routes `/1color/tokens` (paged or `?ids=`), `/1color/<token>`, `/1color/<token>/icon`, `/1color/<token>/deploy`; 0.13.4: its pages submit and look up at the host root, `<origin>/submit` and `<origin>/lookup`; engine skein-overlay 0.20.2: `rebeat` re-declares the configured `ls_color`'s liveness too); root's `/submit`, `/lookup` |

## Build and test

```
zig build test                      # the swap program's tests
zig build bin                       # apps/swap/bin/config.wasm (committed)
scripts/www.sh                      # apps/swap/www (committed): skein-amm v0.35.0's web/ui + the 1Color pages (skein-1color v0.14.0's www/) + api/
npm install --no-save <dcasegr-skein-0.2.8.tgz>   # skein from its `npm pack` until it is published
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
5. (0.17.0) the host is the relay, on hosts of their own: a swap whose commission pays another key
   refused with nothing in the token's log; two, then three, swaps on one pool output relayed at once
   through the host's relay (the validator on its node) → one accepted, the others `pool_spent` with
   its continuation, the pools route at the new outpoint, its trade row; then the same race through
   ANOTHER host's relay (its own key, bootstrapped to the validator) → one accepted, the other
   `pool_spent`, the relaying host's overlay holding the accepted swap when it answers; the
   validator's host stopped → `unreachable` at once
6. disable, then enable again; one token's terms (40/6/3, then null, an unknown token refused)
7. discovery off, then on
8. a restart, with reconcile
9. swap's pages: a restart with a packaged swap app of another version installs it (as root)
10. a replay of every store
