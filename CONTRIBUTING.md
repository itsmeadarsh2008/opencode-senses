# Contributing to OpenCode Senses

First off: thank you for considering a contribution. The model may be the one with eyes, but the repo survives on yours.

This project follows a simple philosophy: **the text model reasons, Senses perceives — and contributors keep both honest.**

## Before you start

- **Read the [README](README.md)** — it documents the architecture, the tools, and the (few) rules that keep this plugin safe.
- **Check open issues** for existing discussion before opening a new one.
- **Keep it local-first.** Senses exists so images never have to leave your machine. Features that quietly exfiltrate data will not be merged, no matter how cool the demo is.

## Repository layout

```
src/plugin.ts                 plugin entry: options, lifecycle, auto-inject wiring
src/opencode/tools.ts         the 13 senses_* tool registrations
src/providers/photon.ts       URL download/cache + JSON-RPC bridge to Python
src/providers/types.ts        request/result contracts (normalized bboxes everywhere)
src/core/context-builder.ts   guards + evidence rendering (<SENSES> blocks)
python/runtime.py             the vision runtime: Moondream + all analysis handlers
python/runtime.test.ts        runtime smoke tests (spawns the real Python runtime)
src/providers/photon.test.ts  URL fetch / cache / materialize unit tests
scripts/build.ts              bundles dist/plugin.js + dist/python/runtime.py
```

## Development setup

Requires [Bun](https://bun.sh), Python 3.10+, and a GPU (NVIDIA or Apple Silicon) for runtime tests.

```bash
git clone https://github.com/itsmeadarsh2008/opencode-senses.git
cd opencode-senses
bun install

# Python runtime + vision deps (if you want to run the runtime tests)
python3 -m venv .venv
source .venv/bin/activate
pip install moondream
```

Point OpenCode at the source plugin while developing:

```json
"plugin": ["./opencode-senses/src/plugin.ts"]
```

## Commands

| Command | What it does |
|---|---|
| `bun run typecheck` | TypeScript types, no emit. Run before every commit. |
| `bun run build` | Bundles `dist/plugin.js` + `dist/python/runtime.py`. |
| `bun test` | Unit + runtime smoke tests. Spawns the real Python runtime — needs `.venv` with `moondream`. |
| `python3 -m py_compile python/runtime.py` | Python syntax check (what CI runs). |

## The two invariants (non-negotiable)

1. **Everything the model reads from an image stays inside `<SENSES>` guards.** Image content is untrusted data. Any code path that surfaces observed text without the guard will be rejected, and your PR will be returned with a polite note and possibly a drawing of a lock.
2. **No analysis handler may ever block message submission.** Senses is a convenience, not a toll booth. If your handler can stall the chat (network, GPU, model load), it must degrade gracefully or run off the critical path.

## Coding conventions

- TypeScript: strict, typed contracts in `src/providers/types.ts` (zod-validated where sensible).
- Python: keep it simple, no external deps beyond `moondream`/torch; the runtime must stay a single-file stdio server.
- Normalized coordinates everywhere: bounding boxes are `[x1, y1, x2, y2]` in `[0, 1]` space. No pixels, no surprises.
- No comments unless they explain *why*; the code should explain *what*.
- Match the existing humor budget. If you make a reviewer laugh, you get one free formatting nit.

## Pull request process

1. Fork, branch (`feat/...`, `fix/...`), commit in small logical units.
2. Run `bun run typecheck` and `bun test` locally before pushing.
3. Open a PR against `main`. Describe what changed, why, and how you verified it (screenshots of evidence output are excellent evidence).
4. CI runs typecheck + build + Python compile. It does **not** run the GPU tests (no GPU in the runner) — so run them yourself.
5. Wait for review. Reviews are performed by humans, slowly, between coffee refills. Bumping the thread after a week is fine; after a day is not.

## Testing guidance

- `src/providers/photon.test.ts` — pure unit tests, no GPU needed.
- `python/runtime.test.ts` — smoke tests that spawn the real runtime and exercise metadata/crop/colors/diff/etc. Needs `.venv` with `moondream` and a GPU. This is the closest thing we have to a full CI; treat failures here as release blockers.
- New tools must ship with at least one smoke test and a line in the README tools table.

## Releasing

Releases are tagged (`v*`) and published by the [publish workflow](.github/workflows/publish.yml) with npm trusted publishing (provenance). Maintainers only:

```bash
bun run typecheck && bun run build
git tag v0.1.1
git push origin v0.1.1
```

The tag push publishes to npm and drafts a GitHub release with auto-generated notes.

## Security

Found a vulnerability? Do **not** open a public issue. See [SECURITY.md](SECURITY.md) for the responsible disclosure path.

## Getting help

- Open a [discussion](https://github.com/itsmeadarsh2008/opencode-senses/discussions) for questions.
- Open an [issue](https://github.com/itsmeadarsh2008/opencode-senses/issues) for bugs and feature requests.
- If you like the project, a coffee helps: [buymeacoffee.com/itsmeadarsh](https://www.buymeacoffee.com/itsmeadarsh). Open source stays alive on donations, not vibes.

## License

By contributing, you agree that your contributions are licensed under [MIT](LICENSE).