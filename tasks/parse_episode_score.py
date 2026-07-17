"""Single source of truth for parsing a task's outcome out of an agent's turns log.

Consolidates two previously-divergent copies (tasks/evaluation_script.py and
tasks/analyse_results.py each had their own analyze_json_file with slightly
different success-string matching) into one function both import, plus a CLI
so achievement_hunter/evaluation_harness/episode_manifest.js can shell out to
it instead of reimplementing the parsing a third time in JS.
"""
import argparse
import json
import sys

SUCCESS_MARKERS = (
    "Task ended with score : 1",
    "Task successful ended with code : 2",
    "Task ended in score: 1",
)
FAILURE_MARKER = "Task ended with score : 0"
SCORE_PREFIX = "Task ended with score : "


def parse_episode_score(file_path):
    """Returns the raw task score (1, 0, or a float for continuous domains
    like construction) parsed from an agent's turns log, or None if the file
    is unreadable or no outcome marker is found.
    """
    try:
        with open(file_path, "r") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None

    turns = data.get("turns") if isinstance(data, dict) else None
    if not isinstance(turns, list):
        return None

    for turn in turns:
        if turn.get("role") != "system" or not isinstance(turn.get("content"), str):
            continue
        content = turn["content"]

        if any(marker in content for marker in SUCCESS_MARKERS):
            return 1
        if FAILURE_MARKER in content:
            return 0
        if SCORE_PREFIX in content:
            try:
                return float(content.split(":")[-1].strip())
            except ValueError:
                continue

    return None


def parse_episode_score_max(file_paths):
    """Runs parse_episode_score over multiple per-agent files (task completion
    is shared state across agents in an episode) and returns the max score
    seen, or None if no file had a parseable outcome.
    """
    scores = [parse_episode_score(path) for path in file_paths]
    scores = [s for s in scores if s is not None]
    return max(scores) if scores else None


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent_file", action="append", dest="agent_files", required=True,
                         help="Path to an agent's turns-log JSON file; repeatable.")
    args = parser.parse_args()

    score = parse_episode_score_max(args.agent_files)
    json.dump({"score": score}, sys.stdout)
