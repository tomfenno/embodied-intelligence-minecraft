# Evaluation Harness v2

This harness runs the five single-agent tasks in
`achievement_hunter/evaluation_harness/advancement_tester.json` for
`baseline_andy` and `our_agent` (`AH_Bot`) using benchmark-generated temp
profiles pinned to `gpt-5`.

## Default behavior

- Runs sequentially, one episode at a time.
- Launches a fresh Minecraft `1.21.6` world for each `agent x seed x task`
  episode when `world.provider` is `managed_local`.
- Uses `survival` mode and `peaceful` difficulty unless overridden in the suite
  config.
- Forces `gamerule spawnRadius 0` in managed-local mode so both agents spawn at
  the same seed-native world spawn point for a given seed.
- Writes artifacts under
  `achievement_hunter/evaluation_harness/experiments/<suite_name>/...`.

## Requirements for managed-local worlds

The configured `world.server_template_path` must point to a reusable vanilla
server template directory that already contains:

- `server.jar`
- `server.properties`
- `eula.txt`

For the benchmark, this template should be a Minecraft `1.21.6` server.
The default committed template for this harness lives at:

`achievement_hunter/evaluation_harness/server_templates/minecraft_1_21_6_clean`

The harness copies that template into a temporary per-episode server
directory and only mutates the temporary clone.

## Common commands

Smoke suite:

```bash
node achievement_hunter/evaluation_harness/cli.js \
  --config achievement_hunter/evaluation_harness/advancement_tester_smoke.json
```

Full suite:

```bash
node achievement_hunter/evaluation_harness/cli.js \
  --config achievement_hunter/evaluation_harness/advancement_tester_suite.json
```

Single agent / single seed verification:

```bash
node achievement_hunter/evaluation_harness/cli.js \
  --config achievement_hunter/evaluation_harness/advancement_tester_smoke.json \
  --agent baseline_andy \
  --seed 12345
```

Single task verification:

```bash
node achievement_hunter/evaluation_harness/cli.js \
  --config achievement_hunter/evaluation_harness/advancement_tester_smoke.json \
  --task pork_chop
```

## External world mode

Use `external` mode to connect the harness to a world you are already running
manually or through Docker:

```bash
node achievement_hunter/evaluation_harness/cli.js \
  --config achievement_hunter/evaluation_harness/advancement_tester_smoke.json \
  --world-provider external \
  --host 127.0.0.1 \
  --port 25565
```

In this mode, the harness and agents run on the local evaluation machine and
only the Minecraft server may be Dockerized or managed separately. Exact spawn
comparability is user-managed in external mode.

## Merging shard outputs

If you split runs across multiple machines, merge the resulting
`results.jsonl` files or suite directories with:

```bash
node achievement_hunter/evaluation_harness/merge_results.js \
  --output achievement_hunter/evaluation_harness/experiments/merged_suite \
  --input path/to/results_a.jsonl \
  --input path/to/results_b.jsonl
```
