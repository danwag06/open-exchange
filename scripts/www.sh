#!/usr/bin/env bash
# apps/swap/www/, the swap app's pages, as committed: the AMM pages built from
# skein-amm's page library (web/ui) at the tag below, then the 1Color pages
# (skein-1color's www/, by tarball URL and sha256) copied into apps/swap/www/color/.
#   AMM_DIR=<a skein-amm checkout at the tag> scripts/www.sh     (default ../skein-amm)
# Needs Node 22+ and npm, and the Rúnar checkout skein-amm's web/ui/README.md names.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
OX="$(pwd)"
AMM_TAG=v0.29.3
AMM_DIR="${AMM_DIR:-$OX/../skein-amm}"
want="$(git -C "$AMM_DIR" rev-parse "${AMM_TAG}^{commit}")"
have="$(git -C "$AMM_DIR" rev-parse HEAD)"
[ "$want" = "$have" ] || { echo "www.sh: $AMM_DIR is at $have, not skein-amm ${AMM_TAG} ($want): check the tag out there (a worktree)" >&2; exit 1; }
(cd "$AMM_DIR/web/engine" && npm ci)
(cd "$AMM_DIR/web/ui" && npm ci && npx tsc -b && npx vite build --outDir "$OX/apps/swap/www" --emptyOutDir)

TAG=v0.12.1
URL="https://github.com/shruggr/skein-1color/archive/refs/tags/${TAG}.tar.gz"
SHA256=7d55df856a4c960d6f9d1d48658d39157f6da8c837c3805037569f85f8be3674
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -sSfL -o "$tmp/c.tar.gz" "$URL"
echo "${SHA256}  $tmp/c.tar.gz" | sha256sum -c --quiet -
tar -xzf "$tmp/c.tar.gz" -C "$tmp" "skein-1color-${TAG#v}/www"
rm -rf apps/swap/www/color
mkdir -p apps/swap/www/color
cp -R "$tmp/skein-1color-${TAG#v}/www/." apps/swap/www/color/
echo "apps/swap/www/ <- skein-amm ${AMM_TAG} web/ui + skein-1color ${TAG} www/"
