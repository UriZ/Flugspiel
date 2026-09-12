#!/usr/bin/env bash
# Re-vendor the arcade game from UriZ/missile-attack-aracde-web. Spec #2 §4.1.
#
#   tools/vendor-game.sh [ref]        # ref defaults to the pinned SHA below
#
# Clones upstream at `ref` into a temp dir, copies its `src/` -> src/game/vendor/
# and its `assets/` -> repo-root assets/, re-writes the ISC grant that upstream does
# not ship (§4.1) and that the wipe below removes, then writes vendor.manifest.json
# with a SHA-256 per file computed FROM THE UPSTREAM TREE. Hashing upstream rather
# than our copy is deliberate: re-running this script can never bless a local
# hand-edit, so tests/game/vendor-integrity.test.js stays a real AC6 check.
set -euo pipefail

REPO=https://github.com/UriZ/missile-attack-aracde-web
REF=${1:-458c3fb67f1d525161806f8a1ca8f9d14dcfcde0}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

command -v shasum >/dev/null && SHA='shasum -a 256' || SHA='sha256sum'

echo "vendoring $REPO @ $REF"
git init -q "$TMP"
git -C "$TMP" remote add origin "$REPO"
git -C "$TMP" fetch -q --depth 1 origin "$REF"
git -C "$TMP" checkout -q FETCH_HEAD
FULL_SHA=$(git -C "$TMP" rev-parse HEAD)

rm -rf "$ROOT/src/game/vendor" "$ROOT/assets"
mkdir -p "$ROOT/src/game"
cp -R "$TMP/src" "$ROOT/src/game/vendor"
cp -R "$TMP/assets" "$ROOT/assets"

# Upstream ships no LICENSE file, only `"license": "ISC"` in its package.json, so the
# grant is ours to carry (§4.1) — and `rm -rf` above just deleted it. Re-create it here
# or every re-vendor silently drops it; tests/game/vendor-integrity.test.js asserts it.
cat > "$ROOT/src/game/vendor/LICENSE" <<'LICENSE_EOF'
ISC License

Copyright (c) UriZ

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
LICENSE_EOF

# Manifest: every file under upstream src/, relative path -> sha256, sorted. Dotfiles
# are skipped to match walk() in vendor-integrity.test.js — .DS_Store and friends are
# not vendored content, and a disagreement would fail T33 for an AC6-unrelated reason.
{
  printf '{\n  "source": "%s",\n  "ref": "%s",\n' "$REPO" "$FULL_SHA"
  printf '  "vendoredAt": "%s",\n  "license": "ISC",\n  "files": {\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  (cd "$TMP/src" && find . -type f -not -path '*/.*' | sed 's|^\./||' | LC_ALL=C sort | while read -r f; do
    printf '    "%s": "%s",\n' "$f" "$($SHA "$f" | cut -d' ' -f1)"
  done) | sed '$ s/,$//'
  printf '  }\n}\n'
} > "$ROOT/src/game/vendor.manifest.json"

echo "vendored $(find "$ROOT/src/game/vendor" -name '*.js' | wc -l | tr -d ' ') .js files"
echo "wrote src/game/vendor.manifest.json"
