// Centralized hyperparameters for the structured loop pipeline.
//
// All tunable knobs (retry budgets, debounce delays, search radii, breadcrumb
// pool sizes, etc.) live here so they can be adjusted in one place. Each
// constant is referenced from exactly one logical site in the pipeline; the
// inline comment notes that site.

// --- Outer loop (loop.js) ---

// Maximum number of outer-loop iterations attempted per task before giving up.
export const MAX_OUTER_RETRIES = 10;

// --- Breadcrumb tracker (breadcrumbs.js, constructed in loop.js) ---

// Minimum horizontal distance (blocks) between any two breadcrumbs.
export const BREADCRUMB_MIN_DIST = 24;

// FIFO capacity for the RECENT pool (current trajectory).
export const BREADCRUMB_RECENT_POOL_SIZE = 16;

// Score-ranked capacity for the LANDMARK pool (diverse waypoints).
export const BREADCRUMB_LANDMARK_POOL_SIZE = 48;

// Sampling interval (ms) at which the breadcrumb tracker considers recording
// a new breadcrumb.
export const BREADCRUMB_PERIOD_MS = 10000;

// Caps the spatial_isolation contribution to a landmark's score (in units of
// BREADCRUMB_MIN_DIST). Prevents a single faraway outlier from dominating.
export const BREADCRUMB_SPATIAL_ISOLATION_CAP = 8;

// --- Inner action runner (actions.js) ---

// Maximum inner-loop retries per action before the outer loop is notified.
export const MAX_INNER_RETRIES = 5;

// Post-craft debounce (ms) inserted after a successful craft to let inventory
// state settle before the next command.
export const CRAFT_DEBOUNCE_MS = 750;

// Cap on the quantity requested by a single collect action.
export const MAX_COLLECT_QTY = 16;

// --- Failure replanner (failure_replanner.js) ---

// Maximum number of recovery attempts (replanner invocations) per failed task.
export const MAX_RECOVERY_ATTEMPTS = 10;

// Maximum retries per individual action inside a recovery plan.
export const FAILURE_REPLANNER_MAX_ACTION_RETRIES = 3;

// --- Search replanner (search_replanner.js) ---

// Maximum number of search-recovery attempts per failed search.
export const MAX_SEARCH_REPLANNER_ATTEMPTS = 10;

// Hard cap on the number of actions a single search-recovery plan may emit.
export const MAX_ACTIONS_PER_PLAN = 10;

// Maximum retries per individual action inside a search-recovery plan.
export const SEARCH_REPLANNER_MAX_ACTION_RETRIES = 3;

// Debounce delay (ms) between actions in a search-recovery plan.
export const ACTION_DEBOUNCE_MS = 750;

// --- Search sweep (search.js) ---

// BFS radius schedule for the multi-target search sweep. Each radius is tried
// against every still-active source before incrementing.
export const SEARCH_RADII = [32, 64, 128, 256];

// --- Pathfinding retry wrappers
// (achievement_hunter/src/agent/pathfinding_wrappers.js) ---
//
// Used by the wrapper module, which lives outside structured_loop but is
// configured here so all tunable knobs sit in one file.

// Maximum consecutive non-progressing retries withPathRetry will accept
// before giving up. Successful midpoint hops reset the counter.
export const PATHFINDING_WRAPPER_MAX_DEPTH = 4;

// XZ closeness passed to skills.goToXZPosition when pathfinding to a
// midpoint hop between the bot and the final target.
export const PATHFINDING_WRAPPER_MIDPOINT_CLOSENESS = 2;

// Max characters of the action's accumulated message preserved in each
// log line's `tail=` field. Keeps log lines readable.
export const PATHFINDING_WRAPPER_LOG_TAIL_MAX_CHARS = 200;

// Directory (relative to repo root) where per-day wrapper logs are
// appended. Created on demand.
export const PATHFINDING_WRAPPER_LOG_DIR =
    'achievement_hunter/logs/pathfinding_wrappers';

// --- Observability (rollout_logger.js) ---

// When true, writes per-run rollout artifacts under
// `rollouts/<timestamp>_<task>/` (rollout_trace.json, breadcrumbs.json,
// task_traces/, search_traces/). Disable to remove all rollout-directory
// sync I/O from the agent's hot path; the agent itself does not read these
// files at runtime, so behavior is unchanged.
export const ENABLE_ROLLOUT_LOGGING = true;

// When true, writes the live dashboard markdown files under `rollout_live/`
// and runs the per-stage markdown rendering. Disable to remove all
// live-viewer sync I/O and rendering work from the agent's hot path.
export const ENABLE_LIVE_VIEWER = false;
