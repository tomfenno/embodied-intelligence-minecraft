"""Descriptive stats and paired significance tests for the GPT-5.5 MineCollab
multi-agent baseline, reading the results.jsonl files produced by
achievement_hunter/evaluation_harness/merge_results.js.

Usage:
    python tasks/analyze_gpt5_baseline_stats.py \
        --results experiments/gpt5_5_baseline_cooking_2agent_<date>/aggregate/results.jsonl \
                  experiments/gpt5_5_baseline_cooking_3agent_<date>/aggregate/results.jsonl \
        --output_dir experiments/gpt5_5_baseline_stats

Binary domains (cooking, crafting) use the `success` column (0/1) for McNemar.
Continuous domains (construction) use `task_score` directly for Wilcoxon,
since binarizing an edit-distance score would throw away information.
"""
import argparse
import json
import os

import pandas as pd
from scipy.stats import wilcoxon
from statsmodels.stats.contingency_tables import mcnemar

BINARY_DOMAINS = {"cooking", "crafting", "techtree"}

# Columns the GPT-5.5 baseline pipeline adds on top of the older single-agent
# results.jsonl schema (agent_label/seed/task_id/success/episode_duration_seconds/
# total_commands). Older files won't have these keys at all, so they're filled
# in as null after loading rather than assumed present.
OPTIONAL_COLUMNS = [
    "team_size", "domain", "task_score", "timeout_used_pct",
    "total_cost_usd", "total_tokens", "total_llm_requests",
]


def load_results(paths):
    rows = []
    for path in paths:
        with open(path, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                rows.append(json.loads(line))
    df = pd.DataFrame(rows)
    for col in OPTIONAL_COLUMNS:
        if col not in df.columns:
            df[col] = None
    return df


def descriptive_stats(df, group_cols):
    if df.empty:
        return pd.DataFrame()
    agg = df.groupby(group_cols, dropna=False).agg(
        runs=("task_id", "count"),
        success_rate=("success", "mean"),
        mean_timeout_used_pct=("timeout_used_pct", "mean"),
        mean_total_commands=("total_commands", "mean"),
        total_cost_usd=("total_cost_usd", "sum"),
        total_tokens=("total_tokens", "sum"),
        total_llm_requests=("total_llm_requests", "sum"),
    ).reset_index()
    return agg


def paired_frame(df, label_a, label_b, pair_cols):
    a = df[df["agent_label"] == label_a].set_index(pair_cols)
    b = df[df["agent_label"] == label_b].set_index(pair_cols)
    joined = a.join(b, lsuffix="_a", rsuffix="_b", how="inner")
    return joined


def run_paired_tests(df, label_a, label_b, results_out):
    pair_cols = ["task_id", "seed", "team_size"]
    joined = paired_frame(df, label_a, label_b, pair_cols)
    if joined.empty:
        print(f"No paired episodes found for {label_a} vs {label_b} on {pair_cols}.")
        return

    binary = joined[joined["domain_a"].isin(BINARY_DOMAINS)]
    if len(binary) >= 1 and not (binary["success_a"] == binary["success_b"]).all():
        table = pd.crosstab(binary["success_a"], binary["success_b"])
        table = table.reindex(index=[0, 1], columns=[0, 1], fill_value=0)
        result = mcnemar(table.values, exact=True)
        results_out.append({
            "comparison": f"{label_a}_vs_{label_b}", "domain": "binary (cooking/crafting/techtree)",
            "test": "mcnemar_exact", "metric": "success", "n_pairs": len(binary),
            "statistic": result.statistic, "p_value": result.pvalue,
        })
    elif len(binary) >= 1:
        results_out.append({
            "comparison": f"{label_a}_vs_{label_b}", "domain": "binary (cooking/crafting/techtree)",
            "test": "mcnemar_exact", "metric": "success", "n_pairs": len(binary),
            "statistic": None, "p_value": None, "note": "no discordant pairs",
        })

    for metric, alternative in [("timeout_used_pct", "less"), ("total_commands", "less")]:
        col_a, col_b = f"{metric}_a", f"{metric}_b"
        pairs = joined[[col_a, col_b]].dropna()
        if len(pairs) < 1 or (pairs[col_a] == pairs[col_b]).all():
            continue
        stat, p = wilcoxon(pairs[col_a], pairs[col_b], alternative=alternative)
        results_out.append({
            "comparison": f"{label_a}_vs_{label_b}", "domain": "all",
            "test": "wilcoxon_signed_rank_one_sided", "metric": metric, "n_pairs": len(pairs),
            "statistic": stat, "p_value": p,
        })

    construction = joined[joined["domain_a"] == "construction"]
    pairs = construction[["task_score_a", "task_score_b"]].dropna()
    if len(pairs) >= 1 and not (pairs["task_score_a"] == pairs["task_score_b"]).all():
        stat, p = wilcoxon(pairs["task_score_a"], pairs["task_score_b"], alternative="greater")
        results_out.append({
            "comparison": f"{label_a}_vs_{label_b}", "domain": "construction",
            "test": "wilcoxon_signed_rank_one_sided", "metric": "task_score", "n_pairs": len(pairs),
            "statistic": stat, "p_value": p,
        })


def run_team_size_ablation(df, results_out):
    """Pairs runs of the same agent_label/task_id/seed across team sizes,
    reproducing the shape of the MineCollab paper's Figure 3a/3b for a single
    model without needing a second labeled condition."""
    for label in df["agent_label"].unique():
        subset = df[df["agent_label"] == label]
        team_sizes = sorted(subset["team_size"].dropna().unique())
        for i in range(len(team_sizes) - 1):
            size_a, size_b = team_sizes[i], team_sizes[i + 1]
            a = subset[subset["team_size"] == size_a].set_index(["task_id", "seed"])
            b = subset[subset["team_size"] == size_b].set_index(["task_id", "seed"])
            joined = a.join(b, lsuffix="_a", rsuffix="_b", how="inner")
            if joined.empty:
                continue

            binary = joined[joined["domain_a"].isin(BINARY_DOMAINS)]
            if len(binary) >= 1 and not (binary["success_a"] == binary["success_b"]).all():
                table = pd.crosstab(binary["success_a"], binary["success_b"])
                table = table.reindex(index=[0, 1], columns=[0, 1], fill_value=0)
                result = mcnemar(table.values, exact=True)
                results_out.append({
                    "comparison": f"{label}_team{int(size_a)}_vs_team{int(size_b)}",
                    "domain": "binary (cooking/crafting/techtree)",
                    "test": "mcnemar_exact", "metric": "success", "n_pairs": len(binary),
                    "statistic": result.statistic, "p_value": result.pvalue,
                })


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--results", nargs="+", required=True,
                         help="One or more results.jsonl files to load and concatenate")
    parser.add_argument("--output_dir", default="experiments/baseline_stats")
    parser.add_argument("--condition_a", default=None, help="agent_label for one side of a paired comparison")
    parser.add_argument("--condition_b", default=None, help="agent_label for the other side of a paired comparison")
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)
    df = load_results(args.results)
    if df.empty:
        print("No results loaded.")
        return

    per_task_domain = descriptive_stats(df, ["agent_label", "domain", "task_id"])
    per_team_size = descriptive_stats(df, ["agent_label", "domain", "team_size"])
    overall = descriptive_stats(df, ["agent_label"])

    print("=== Overall ===")
    print(overall.to_string(index=False))
    print("\n=== By domain / team size ===")
    print(per_team_size.to_string(index=False))

    per_task_domain.to_csv(os.path.join(args.output_dir, "descriptive_per_task.csv"), index=False)
    per_team_size.to_csv(os.path.join(args.output_dir, "descriptive_by_team_size.csv"), index=False)
    overall.to_csv(os.path.join(args.output_dir, "descriptive_overall.csv"), index=False)

    test_results = []
    if args.condition_a and args.condition_b:
        run_paired_tests(df, args.condition_a, args.condition_b, test_results)
    else:
        run_team_size_ablation(df, test_results)

    stats_df = pd.DataFrame(test_results)
    stats_path = os.path.join(args.output_dir, "stats_summary.csv")
    stats_df.to_csv(stats_path, index=False)

    print(f"\n=== Statistical tests ({len(test_results)}) ===")
    if not stats_df.empty:
        print(stats_df.to_string(index=False))
    print(f"\nWrote descriptive CSVs and {stats_path}")


if __name__ == "__main__":
    main()
