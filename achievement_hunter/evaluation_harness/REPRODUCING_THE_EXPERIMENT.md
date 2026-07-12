# Reproducing the Evaluation Experiment

This document describes how to set up the environment and re-run the
`achievement_hunter` evaluation harness exactly as it was used to produce the
results reported in the thesis. It complements `README.md` in this directory,
which covers harness CLI usage in more detail.

## 1. Frozen reference point

The `evaluation` branch was merged into `main` on 2026-07-11 (merge commit
`d5a6a6f`, "Merge branch 'post-eval' into evaluation"). At the time of
freezing, `main` and `evaluation` point to the same commit, so the tag below
is the authoritative snapshot for recreating the experiment regardless of
what happens to either branch afterward:

```
git tag -v eval-frozen-2026-07-11   # verify once created, see below
```

If you are trying to reproduce the experiment and this tag does not resolve,
ask for the exact commit hash instead — the tag is a pointer, the commit hash
is ground truth.

## 2. Environment setup

1. **Minecraft Java Edition** is not required to be installed separately —
   the harness manages its own server. The pinned server template (including
   `server.jar` for Minecraft `1.21.6`) is committed at
   `achievement_hunter/evaluation_harness/server_templates/minecraft_1_21_6_clean/`.
2. **Node.js**: use Node v18 or v20 LTS (the project README warns Node v24+
   can break native dependencies like `canvas`).
3. Clone the repo and check out the frozen commit/tag:
   ```bash
   git clone https://github.com/tomfenno/embodied-intelligence-minecraft.git
   cd embodied-intelligence-minecraft
   git checkout eval-frozen-2026-07-11
   ```
4. Install dependencies using the committed lockfile (do not run
   `npm update` first — the experiment was run against the exact versions in
   `package-lock.json`):
   ```bash
   npm ci
   ```
5. Copy `keys.example.json` to `keys.json` and fill in the API key(s) needed
   for the agents under test. The evaluation suite pins agents to `gpt-5`
   (see `achievement_hunter/evaluation_harness/profiles/`), so at minimum you
   need `OPENAI_API_KEY`.
6. (Optional, only needed for scripts under `tasks/`) create a Python
   environment and install `requirements.txt`:
   ```bash
   pip install -r requirements.txt
   ```

## 3. Running the harness

The harness is invoked through `cli.js` and reads a suite config JSON. The
full suite used for the experiment is
`achievement_hunter/evaluation_harness/advancement_tester_suite.json`, which
defines three agents (`baseline_andy`, `baseline_andy_simple`, `our_agent`)
against three fixed world seeds, run in `survival` mode / `peaceful`
difficulty on a managed-local Minecraft `1.21.6` server:

```bash
node achievement_hunter/evaluation_harness/cli.js \
  --config achievement_hunter/evaluation_harness/advancement_tester_suite.json
```

Useful variants:

| Goal | Command |
|---|---|
| Smoke test before a full run | `--config .../advancement_tester_smoke.json` |
| Re-run one agent only | add `--agent baseline_andy` (repeatable) |
| Re-run one seed only | add `--seed 12345` (repeatable) |
| Re-run one task only | add `--task pork_chop` (repeatable) |
| Connect to a manually-run world instead of managed-local | add `--world-provider external --host 127.0.0.1 --port 25565` |

Runs are sequential (one episode at a time) and write artifacts to
`achievement_hunter/evaluation_harness/experiments/<suite_name>/...`
(git-ignored). Each `agent x seed x task` combination launches a fresh
world copy so runs don't contaminate each other.

If you split the suite across multiple machines by seed, merge the resulting
`results.jsonl` files with:

```bash
node achievement_hunter/evaluation_harness/merge_results.js \
  --output achievement_hunter/evaluation_harness/experiments/merged_suite \
  --input path/to/results_a.jsonl \
  --input path/to/results_b.jsonl
```

`per_task.csv` and `summary.csv` in the merged output are what feed the
figures/tables in the thesis.

## 4. Validating the environment before trusting a re-run

Before treating a re-run as comparable to the original results, check:

- `node -v` matches an LTS in the 18.x/20.x range.
- `npm ci` (not `npm install`) was used, so `package-lock.json` was honored.
- `git status` is clean against the frozen tag — no local modifications to
  `achievement_hunter/evaluation_harness/` or `profiles/`.
- The agent profiles still resolve to the same model IDs (`gpt-5` etc.) — if
  the provider has deprecated that model, results will not be directly
  comparable even with identical code.
- Same world seeds are in play (`achievement_hunter/evaluation_harness/advancement_tester_suite.json` → `world.seeds`).

## 5. Known non-determinism

Even on the frozen commit, exact numeric reproduction is not guaranteed
because:

- LLM API responses are not fully deterministic even at temperature 0.
- Minecraft world generation for a seed can differ across server versions;
  the server jar is pinned in the repo specifically to avoid this.
- Wall-clock timeouts in the harness can behave differently under different
  hardware/network load, which can change failure classification for
  borderline episodes.

Treat single re-runs as a sanity check, not a bit-for-bit replication; for a
real reproduction, run the full seed set and compare aggregate success rates
in `summary.csv`, not individual episode outcomes.
