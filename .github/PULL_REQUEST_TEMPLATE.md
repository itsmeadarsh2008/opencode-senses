## What does this PR do?

Brief description of the change and the problem it solves.

## How was it verified?

- [ ] `bun run typecheck` passes
- [ ] `bun test` passes (requires `.venv` with `moondream` + GPU)
- [ ] `python3 -m py_compile python/runtime.py` passes
- [ ] Manual testing done (attach evidence output if useful)

## Checklist

- [ ] The two invariants hold: evidence stays in `<SENSES>` guards, and no handler blocks message submission
- [ ] New tools are registered in `src/opencode/tools.ts`, typed in `src/providers/types.ts`, and documented in the README tools table
- [ ] Normalized `[0,1]` coordinates used for any bbox/point output
- [ ] No secrets, no telemetry, no surprises

## Related issues

Fixes #...