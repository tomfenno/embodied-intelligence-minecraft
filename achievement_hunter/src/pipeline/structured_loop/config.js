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
