# Shared actions reference

`actions_reference.master.json` is the **single source of truth** for the per-role action reference files:

- `achievement_hunter/docs/prompts/failure_replanner/actions_reference.json`
- `achievement_hunter/docs/prompts/search_replanner/actions_reference.json`

Both per-role files are **generated** — do not edit them directly.

## Adding or editing an action

1. Edit `actions_reference.master.json`.
2. On each entry, set `include_in: ["failure_replanner", "search_replanner"]` listing the roles that should receive it.
3. Optional per-role deviation via `overrides: { "<role>": { ... } }` — deep-merged onto the base entry.
4. Regenerate:

   ```
   node achievement_hunter/scripts/build_action_refs.mjs
   ```

5. Commit the master *and* both generated files together.

## CI / freshness check

`achievement_hunter/scripts/build_action_refs.mjs --check` exits non-zero if either generated file is out of date relative to the master. A vitest test (`achievement_hunter/src/__tests__/action_refs_sync.test.js`) enforces this on every test run.
