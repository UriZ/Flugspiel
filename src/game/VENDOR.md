# Vendored game

`src/game/vendor/` is a verbatim copy of the `src/` tree of
[UriZ/missile-attack-aracde-web](https://github.com/UriZ/missile-attack-aracde-web),
pinned to commit `458c3fb67f1d525161806f8a1ca8f9d14dcfcde0`. The repo-root `assets/`
directory is a verbatim copy of that commit's `assets/`.

| | |
|---|---|
| Source | https://github.com/UriZ/missile-attack-aracde-web |
| Ref | `458c3fb67f1d525161806f8a1ca8f9d14dcfcde0` |
| License | ISC (declared in upstream `package.json`; upstream ships no LICENSE file — see below) |
| Files | 48 `.js` under `vendor/`, 8.3 MB under `assets/` |

## Rules

**No file under `src/game/vendor/` may be modified.** That is acceptance criterion 6
of issue #2 and it is enforced by `tests/game/vendor-integrity.test.js`, which
recomputes a SHA-256 for every file and compares it against `vendor.manifest.json`.

All Flugspiel code lives in sibling files (`virtual-input.js`, `state-codec.js`,
`fly-bridge.js`, `index.js`) and drives the game through `game.input` only.

## Why vendored rather than a submodule

Upstream loads its assets document-relative (`assets/coverfinal.png`,
`assets/radio/*`), so a submodule would put them under `<submodule>/assets/` and
require a root symlink (which GitHub Pages does not follow) or a duplicate copy.
Vendoring also makes AC6 mechanically checkable offline via the hash manifest.

Upstream's `package.json`, `package-lock.json` and its `puppeteer` devtooling
dependency are deliberately **not** carried over — Flugspiel stays dependency-free.

## Updating

```sh
tools/vendor-game.sh <new-upstream-sha>
npm test
```

The script hashes the *upstream* tree, not our copy, so re-running it can never
bless a local hand-edit. Review the `vendor.manifest.json` diff in the PR.

## License note

Upstream declares `"license": "ISC"` in `package.json` but has **no LICENSE file**,
so that field is currently the only grant. `vendor/LICENSE` carries the ISC text.
Both repos are owned by UriZ, so this is a formality — but the missing file should
be fixed upstream.
