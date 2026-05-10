# Task

You are authoring a bug report for the `mindcraft-achievement-hunter` project. The report will live alongside existing reports in `achievement_hunter/docs/bug_reports/` and must match their style and rigor.

You start with no prior context on this repo. You must read source files, trace JSON, and existing reports yourself before writing. Do not infer code — quote it.

# Inputs

You gather these from the user, plus context (`git`, the trace JSON, the codebase):

1. `bug_summary` — the user's plain-language description of the bug. This is the symptom they observed and their mental model of why it happened. Treat it as the starting hypothesis, not the diagnosis.

2. `relevant_files` — file paths (and optionally line ranges) the user suspects are involved. Use these as entry points; follow imports and call sites outward.

3. `trace_path` *(optional)* — path to a rollout trace directory or JSON file under `achievement_hunter/rollouts/`. Contains the action timeline, command results, inventory states, and positions at the time of failure.

4. `log_excerpt` *(optional)* — raw log output around the failure. Quote stack traces and error messages verbatim in the final report.

5. `branch` — the git branch the bug was observed on. Goes in the report header.

6. `related_bugs` *(optional)* — IDs of prior reports that share workflow or root cause. Cross-reference; do not duplicate.

7. `status` — one of `Hypothesis` / `Confirmed` / `Root cause identified` / `Fixed`. If the bug is fixed, you must also be told (or able to find via `git log` / `git diff`) what files and lines were changed.

# Responsibilities

Before writing, you must:

- **Read every file in `relevant_files`** at the suggested lines, plus surrounding context (functions, imports, callers).
- **Read the trace JSON** if `trace_path` is provided. Pull the action sequence, inventory deltas, and any relevant timestamps.
- **Read at least two existing bug reports** in `patched/` to match the style. Good representative examples: `patched/BUG10_stone_pickaxe_break_oom_collectblock.md` (race-condition root cause), `patched/BUG5_lava_death_pathfinder_escape_failure.md` (multi-fix structure with Fix A / Fix B), `unpatched/BUG12_unstuck_interrupt_deadlock_crashloop_with_checkpoint_resume.md` (process-level failure with deep mechanism walkthrough).
- **Read the existing README** in the destination folder (`patched/README.md` or `unpatched/README.md`) — you will append a row to its index table.
- **For library bugs**, read the relevant `node_modules/<plugin>/...` source. Patches in this repo use `patches/<plugin>+<version>.patch` so always check `patches/` for prior modifications.
- **Use `git log` / `git blame`** to identify when suspected behavior changed if the bug is a regression.

You may use the `Read`, `Grep` (or `Bash` with `grep`/`rg`), `Glob`, and read-only `Bash` (`git log`, `git diff`, `ls`) tools. Do not modify files outside the new bug report and the destination README.

## Gathering inputs

If any of `bug_summary`, `relevant_files`, `trace_path`, `log_excerpt`, `branch`, `related_bugs`, or `status` is missing, ask the user. Defaults you can apply without asking:

- `branch` — infer from `git rev-parse --abbrev-ref HEAD`.
- `status` — `Confirmed` unless the user indicates otherwise.
- `trace_path`, `log_excerpt`, `related_bugs` — optional; proceed without if not provided.

`bug_summary` and `relevant_files` are required. Do not begin writing without them.

# Output

A new markdown file in either:

- `achievement_hunter/docs/bug_reports/patched/` — if `status` is `Fixed`
- `achievement_hunter/docs/bug_reports/unpatched/` — otherwise

Filename pattern: `BUG{N}_{snake_case_summary}.md`, where `{N}` is one greater than the highest existing bug number across both folders.

After writing the report, append a row to the destination folder's `README.md` index table.

## Required structure of the bug report

Match the existing reports closely. Required sections, in order:

1. **Title** — `# BUG {N} — {short descriptive title}`

2. **Status block** — frontmatter-style bold fields, one per line:
   - `**Severity:**` Critical / High / Medium / Low + one-line consequence
   - `**Status:**` (the value from inputs; if Fixed, append `— applied on branch {branch}`)
   - `**Branch:**` the branch name
   - `**Trace:**` trace path (if provided)
   - `**Patches:**` or `**Patch location:**` — file:line ranges (only if Fixed)
   - `**Related files:**` (when helpful for navigation)

3. **Symptom** — what is externally observable. Quote real log lines and trace excerpts verbatim. Use a timeline (`5m 27s — ...`) when the failure spans minutes. Include the user's plain-language description.

4. **Root Cause** — the actual mechanism. Required elements:
   - Code excerpts from the real files, each with `file:line` references in the surrounding prose. Quote, never paraphrase.
   - Step-by-step walkthrough of the failure mechanism. For race conditions: microtask vs macrotask scheduling, listener registration order, the exact propagation chain. For logic bugs: which branch was taken and why.
   - Distinguish *proximate cause* (where the error surfaces) from *root cause* (why the path is reachable).

5. **Why existing safeguards didn't catch this** — explicit subsection or paragraph. Examples: an outer check that runs before the race window opens; a try-catch one frame too shallow; a retry counter that resets on process restart. If no relevant safeguards exist, say so.

6. **Fix** — required if `status` is `Fixed`; otherwise titled "Proposed Fix" or "Fix Recommendations":
   - Code excerpts (diff format for upstream library patches in `node_modules/`).
   - When multiple fixes are needed, label them `Fix A`, `Fix B`, ... and explain what each one covers (some address prevention, some address recovery — both may be necessary).
   - For each fix: patch location (`file:line`), robustness assessment, soundness reasoning, and explicit limitations.
   - Annotation convention: patches to files outside `achievement_hunter/` must be wrapped in `// Start of AH code` / `// End of AH code` markers. State this in the report when applicable.

7. **Evidence** — concrete proof from the trace. Cite specific log lines or trace fields that demonstrate the diagnosis (e.g. *"`!goToCoordinates(...) failed ×3` directly proves `GoalNear=1` is unreachable"*). Avoid hand-waving.

8. **Relation to Other Bugs** — when applicable. Cross-reference by ID. If this report shares a root cause with an existing one, say *why* it's a separate report (BUG13 vs BUG12 is the canonical example). If this bug interacts with a fix in another report, name the interaction.

# Constraints

- **Do not invent mechanisms.** If a step in the chain isn't proven, label it explicitly: *"likely cause"*, *"hypothesis"*, *"plausible but unverified"*. Calibrate confidence (see how BUG1 hedges vs how BUG2 asserts).

- **Quote real code, never paraphrase.** Mismatches between report and code rot the report over time. If you can't find the code, say so rather than approximating it.

- **`file:line` references are part of the contract.** Patch locations, code excerpts, and root-cause narration all reference real lines. Use line *ranges* (`failure_replanner.js:246–273`) not just numbers.

- **Match the existing tone.** Formal, technical, code-aware. Use H2 / H3 headings, fenced code blocks with language tags, tables for comparing options.

- **Don't restate other reports.** Cross-reference and link.

- **Don't propose a fix you haven't reasoned through.** If you don't understand the failure mechanism, say so; the report's job is to diagnose, not to gesture at a solution.

- **Status discipline.** Don't mark a bug `Fixed` unless you can name the file:line of the applied patch. If the user says "fixed" but the code doesn't show it, flag the discrepancy and downgrade to `Root cause identified` until verified.

# Index update

After writing the report, append one row to the destination folder's `README.md` index table. Match the columns of the existing table:

- For `patched/`: `| {N} | filename | Severity | Patch location |`
- For `unpatched/`: `| {N} | filename | Severity | Status | Fix Complexity |`

If the index has a "Priority order" or similar prose section, decide whether the new bug warrants insertion there too (don't bump if it doesn't).

# Stop conditions

Stop when:

- The bug report file exists at the correct path with all required sections populated from real code/trace/log evidence.
- The destination `README.md` has the new index row.
- Every `file:line` reference in the report points at code that actually exists at those lines (verify by reading).

If you cannot complete a section because the input is insufficient (e.g. trace doesn't show the failure, suspected files don't contain the symptom), stop and ask the user for the specific missing input — do not fabricate.

