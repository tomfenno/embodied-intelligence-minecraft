import {getBiomeName, getPosition} from '../../../../src/agent/library/world.js';

import {get_am_state} from '../agent_state.js';
import {executeCommandWithModeRecovery as execute_command} from '../command_utils.js';
import {any_log_search_targets, mob_search_targets} from '../mc_sources.js';

import {SEARCH_RADII} from './config.js';
import {make_spl} from './log.js';
// PR-A-D verification
import {verify_log} from './_pr_a_d_verify_log.js';
import {
  build_search_exhausted_message,
  build_search_found_not_reached_message,
  build_search_success_message,
  parse_skill_output,
} from './result_messages.js';

const spl = make_spl('[SPL]');

const log_source = {
  search: 'search',
};

export function parse_search_command(action) {
  const match = action.trim().match(/^!search\("([^"]+)"\)$/);
  return match?.[1] ?? null;
}

// "You have reached at X, Y, Z." — the skill ultimately navigated to the
// located block. When BOTH the skill said it found+reached AND
// check_search_complete still rejects the target, the issue is the
// state filter (e.g. flowing lava vs source lava); larger radii can
// genuinely help find a different instance. Without this guard, we'd
// classify every state-filter rejection as found_not_reached and skip
// larger radii prematurely. Used together with parse_skill_output's
// located_at detection: located + NOT reached ⇒ pathfinder bailed,
// safe to skip larger radii for this item.
const REACHED_PATTERN = /You have reached at /;

// Accumulate parse_skill_output across per-radius messages. Earlier
// matches win for location fields (the smallest radius that located the
// target is the most useful coord), and no_tool wins over pathfinder_bail
// for blocker classification (more specific) even when pathfinder_bail
// was observed at a smaller radius.
function accumulate_parsed(accum, message) {
  if (typeof message !== 'string' || message.length === 0) return accum;
  const parsed = parse_skill_output(message);
  if (parsed.located_at && !accum.located_at) {
    accum.located_at = parsed.located_at;
  }
  if (parsed.located_distance != null && accum.located_distance == null) {
    accum.located_distance = parsed.located_distance;
  }
  if (parsed.blocker_kind === 'no_tool' && accum.blocker_kind !== 'no_tool') {
    accum.blocker_kind = 'no_tool';
    accum.blocker_detail = parsed.blocker_detail;
  } else if (parsed.blocker_kind === 'pathfinder_bail' && !accum.blocker_kind) {
    accum.blocker_kind = 'pathfinder_bail';
    accum.blocker_detail = parsed.blocker_detail;
  }
  return accum;
}

function snapshot_bot_context(agent) {
  let bot_pos = null;
  let bot_biome = null;
  try {
    const pos = getPosition(agent?.bot);
    if (pos != null) {
      bot_pos = {
        x: Number(pos.x.toFixed(1)),
        y: Number(pos.y.toFixed(1)),
        z: Number(pos.z.toFixed(1)),
      };
    }
  } catch {
  }
  try {
    const biome = getBiomeName(agent?.bot);
    if (biome != null) bot_biome = biome;
  } catch {
  }
  return {bot_pos, bot_biome};
}

/**
 * Runs a !search for `target`, sweeping SEARCH_RADII until success or
 * exhaustion. Classifies the outcome and builds the result message via
 * the shared builders so callers get a structured prefix the LLM can
 * parse.
 *
 * Returns one of:
 *   {found: true, outcome: 'reached', message, located_at?, located_distance?}
 *   {found: false, outcome: 'absent', message}
 *   {found: false, outcome: 'found_not_reached', message,
 *     located_at?, located_distance?, blocker_kind?, blocker_detail?}
 *
 * On bot death mid-sweep, `bot_died: true` is set on the return so
 * callers can short-circuit rather than acting on a stale state.
 *
 * Unsupported abstract targets (those `expand_search_item` throws on)
 * soft-skip to `outcome: 'absent'` rather than propagating the throw —
 * mirrors the multi-target sweep's handling so a misconfigured graph
 * can't crash the rollout.
 */
export async function run_search(target, state, agent, log, start_attempt) {
  let concrete_items;
  try {
    concrete_items = expand_search_item(target);
  } catch (e) {
    spl.warn(`Unsupported abstract target "${target}" — treating as absent. (${
        e.message})`);
    const ctx = snapshot_bot_context(agent);
    // PR-A-D verification
    verify_log('run_search_classified',
        {target, outcome: 'absent', reason: 'unsupported_abstract'});
    return {
      found: false,
      outcome: 'absent',
      message: build_search_exhausted_message(
          {target, bot_pos: ctx.bot_pos, bot_biome: ctx.bot_biome}),
    };
  }

  for (const item of concrete_items) {
    if (check_search_complete(item, state)) {
      spl.log(`Search fast-path: "${item}" already in state.`);
      // PR-A-D verification
      verify_log('run_search_classified',
          {target, outcome: 'reached', reason: 'fast_path'});
      return {
        found: true,
        outcome: 'reached',
        message: build_search_success_message({target}),
      };
    }
  }

  let attempt = start_attempt;
  let last_message = null;
  const accum = {};
  // Items whose location was already established at a smaller radius but
  // which the bot couldn't reach. Skipped at larger radii so abstract
  // searches (multi-item) still try alternatives, but a single repeatedly-
  // unreachable item doesn't burn budget on every radius.
  const found_but_not_reached = new Set();

  for (const radius of SEARCH_RADII) {
    for (const item of concrete_items) {
      if (found_but_not_reached.has(item)) continue;
      const command = make_search_command(item, radius);
      log.am(++attempt, command, null, {source: log_source.search});
      const {found, message} =
          await execute_search_command(agent, item, radius, command);
      if (message != null) last_message = message;
      accumulate_parsed(accum, message);

      if (agent.bot._ah_death_pending) {
        spl.log(`Bot death observed during run_search — aborting radii loop for "${target}".`);
        return {
          found: false,
          outcome: 'absent',
          message: last_message,
          bot_died: true,
        };
      }
      if (found) {
        // PR-A-D verification
        verify_log('run_search_classified', {
          target,
          outcome: 'reached',
          located_at: accum.located_at ?? null,
          located_distance: accum.located_distance ?? null,
        });
        return {
          found: true,
          outcome: 'reached',
          message: build_search_success_message({
            target,
            located_at: accum.located_at,
            located_distance: accum.located_distance,
          }),
          located_at: accum.located_at,
          located_distance: accum.located_distance,
        };
      }
      // Located-but-not-reached for blocks: parsed.located_at is set and
      // the skill DID NOT log "You have reached". For entities, the skill
      // doesn't emit precise coords ("Found pig N blocks away" lacks a
      // reached marker we can rely on), so the early-skip applies only
      // to blocks. Larger radii might find a different reachable entity.
      const parsed = parse_skill_output(message);
      if (parsed.located_at && !REACHED_PATTERN.test(message ?? '')) {
        spl.log(`Search: "${item}" located at radius ${radius} but not reached — skipping larger radii for this item.`);
        found_but_not_reached.add(item);
      }
    }
    if (found_but_not_reached.size >= concrete_items.length) {
      spl.log(`All ${concrete_items.length} item(s) located but unreachable — exhausting search early.`);
      break;
    }
  }

  const ctx = snapshot_bot_context(agent);
  // Determine outcome: if anything was located along the way (either
  // located_at coords for a block, or a distance for an entity that the
  // bot then failed to reach), classify as found_not_reached. Otherwise
  // the target truly is absent from the radius schedule.
  const located_anywhere =
      accum.located_at != null || accum.located_distance != null;
  if (located_anywhere) {
    // PR-A-D verification
    verify_log('run_search_classified', {
      target,
      outcome: 'found_not_reached',
      located_at: accum.located_at ?? null,
      located_distance: accum.located_distance ?? null,
      blocker_kind: accum.blocker_kind ?? null,
    });
    return {
      found: false,
      outcome: 'found_not_reached',
      message: build_search_found_not_reached_message({
        target,
        located_at: accum.located_at,
        located_distance: accum.located_distance,
        blocker_kind: accum.blocker_kind,
        blocker_detail: accum.blocker_detail,
        bot_pos: ctx.bot_pos,
      }),
      located_at: accum.located_at,
      located_distance: accum.located_distance,
      blocker_kind: accum.blocker_kind,
      blocker_detail: accum.blocker_detail,
    };
  }
  // PR-A-D verification
  verify_log('run_search_classified',
      {target, outcome: 'absent', bot_pos: ctx.bot_pos});
  return {
    found: false,
    outcome: 'absent',
    message: build_search_exhausted_message(
        {target, bot_pos: ctx.bot_pos, bot_biome: ctx.bot_biome}),
  };
}

/**
 * Multi-target breadth-first search sweep. For each radius in
 * SEARCH_RADII, attempts every still-active source before incrementing
 * the radius (per D4). Returns as soon as any source's concrete member
 * is found AND reached, or after all sources exhaust at all radii.
 *
 * Abstract sources (e.g. `any_log`) are expanded via `expand_search_item`.
 * Unsupported abstracts soft-skip with `outcome: 'soft_skipped'`.
 *
 * Per-source outcomes are now structured objects (was: strings) so the
 * sweep handler can seed the search_replanner with located_at / blocker
 * info per source rather than just a coarse status label.
 *
 * @param {string[]} sources — target names (concrete or registered abstract).
 * @param {object} agent
 * @param {object} log — rollout logger.
 * @param {Set<string>} searched_targets — per-attempt dedup set; mutated as
 *     sources are ruled out.
 * @param {number} start_attempt — AM-log attempt index.
 * @returns {Promise<{
 *   found: boolean,
 *   source?: string,
 *   item?: string,
 *   message?: string|null,
 *   sources_exhausted?: string[],
 *   outcomes: { [source: string]: {
 *     outcome: 'found_reached' | 'found_not_reached' | 'exhausted'
 *            | 'soft_skipped' | 'not_attempted',
 *     located_at?: {x,y,z},
 *     located_distance?: number,
 *     blocker_kind?: 'no_tool' | 'pathfinder_bail',
 *     blocker_detail?: string,
 *     last_message?: string,
 *   } }
 * }>}
 */
export async function run_breadth_first_sweep(
    sources, agent, log, searched_targets, start_attempt) {
  const outcomes = {};
  for (const source of sources) outcomes[source] = {outcome: 'not_attempted'};

  // Pre-expand sources; soft-skip unsupported abstracts.
  const expanded = [];
  const per_source_accum = {};
  for (const source of sources) {
    per_source_accum[source] = {};
    let items;
    try {
      items = expand_search_item(source);
    } catch (e) {
      spl.warn(
          `Sweep: unsupported abstract target "${source}" — skipping. ` +
          `Add expansion in expand_search_item. (${e.message})`);
      searched_targets.add(source);
      outcomes[source] = {outcome: 'soft_skipped'};
      continue;
    }
    expanded.push({source, items});
  }

  if (expanded.length === 0) {
    return {
      found: false,
      sources_exhausted: sources.slice(),
      outcomes,
      message: null,
    };
  }

  // Fast path: any concrete item of any expanded source already nearby?
  const initial_state = get_am_state(agent);
  for (const {source, items} of expanded) {
    for (const item of items) {
      if (check_search_complete(item, initial_state)) {
        spl.log(
            `Sweep fast-path: "${item}" (from "${source}") already in state.`);
        outcomes[source] = {outcome: 'found_reached'};
        return {found: true, source, item, message: null, outcomes};
      }
    }
  }

  spl.log(
      `Sweep starting: sources=[${expanded.map(e => e.source).join(', ')}]`);

  let active = expanded.slice();
  let attempt = start_attempt;
  let last_message = null;

  for (const radius of SEARCH_RADII) {
    for (const entry of active.slice()) {
      const {source, items} = entry;
      if (searched_targets.has(source)) continue;
      const accum = per_source_accum[source];

      let target_done = false;
      for (const item of items) {
        const command = make_search_command(item, radius);
        log.am(++attempt, command, null, {source: log_source.search});
        const {found, message} =
            await execute_search_command(agent, item, radius, command);
        if (message != null) {
          last_message = message;
          accum.last_message = message;
        }
        accumulate_parsed(accum, message);

        if (agent.bot._ah_death_pending) {
          spl.log(`Bot death observed during sweep — aborting at "${item}" r=${radius}.`);
          return {
            found: false,
            sources_exhausted: sources.slice(),
            outcomes,
            message: last_message,
            bot_died: true,
          };
        }
        if (found) {
          if (check_search_complete(item, get_am_state(agent))) {
            outcomes[source] = {
              outcome: 'found_reached',
              located_at: accum.located_at,
              located_distance: accum.located_distance,
            };
            return {found: true, source, item, message, outcomes};
          }
          spl.warn(
              `Sweep: "${item}" (from "${source}") found but bot did ` +
              `not reach it. Marking source done for this sweep.`);
          searched_targets.add(source);
          outcomes[source] = {
            outcome: 'found_not_reached',
            located_at: accum.located_at,
            located_distance: accum.located_distance,
            blocker_kind: accum.blocker_kind,
            blocker_detail: accum.blocker_detail,
            last_message: accum.last_message,
          };
          target_done = true;
          break;
        }
      }
      if (target_done) {
        active = active.filter(e => e !== entry);
      }
    }
    if (active.length === 0) break;
  }

  // All remaining sources exhausted at the last radius. If anything was
  // located along the way (just couldn't be reached), classify as
  // found_not_reached for that source instead of plain exhausted.
  for (const {source} of active) {
    searched_targets.add(source);
    const accum = per_source_accum[source];
    const located_anywhere =
        accum.located_at != null || accum.located_distance != null;
    outcomes[source] = located_anywhere
        ? {
            outcome: 'found_not_reached',
            located_at: accum.located_at,
            located_distance: accum.located_distance,
            blocker_kind: accum.blocker_kind,
            blocker_detail: accum.blocker_detail,
            last_message: accum.last_message,
          }
        : {
            outcome: 'exhausted',
            last_message: accum.last_message,
          };
  }
  return {
    found: false,
    sources_exhausted: sources.slice(),
    outcomes,
    message: last_message,
  };
}

async function execute_search_command(agent, item, radius, command) {
  spl.log(`Search (${item} r=${radius}):`, command);
  const result = await execute_command(agent, command);
  await sleep(500);
  spl.log('Search result:', result);

  const message =
      result?.message != null ? String(result.message).trim() : null;

  // Post-condition: the bot's actual nearby state is the only honest
  // success signal. The skill's success flag and message text are
  // intentionally ignored — see the previous version of this comment
  // for the three failure modes (Could not find false-positive,
  // intermediate pathfinder warnings, genuine bail without reach).
  const found = check_search_complete(item, get_am_state(agent));

  if (found)
    spl.log(`Search succeeded: "${item}" at radius ${radius}.`);
  else
    spl.warn(`Search failed: "${item}" at radius ${radius}.`);
  return {found, message};
}

export function expand_search_item(item) {
  if (item === 'any_log') return any_log_search_targets;
  if (item.startsWith('any_')) {
    throw new Error(`Unsupported abstract search target: "${
        item}". Add an expansion to expand_search_item.`);
  }
  return [item];
}

export function is_entity_target(target) {
  return mob_search_targets.has(target);
}

export function check_search_complete(target, state) {
  return is_entity_target(target) ?
      (state.nearby_entities?.mobs?.includes(target) ?? false) :
      (state.nearby_blocks?.includes(target) ?? false);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function make_search_command(target, radius) {
  return is_entity_target(target) ? `!searchForEntity("${target}", ${radius})` :
                                    `!searchForBlock("${target}", ${radius})`;
}
