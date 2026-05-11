import {get_am_state} from '../agent_state.js';
import {executeCommandWithModeRecovery as execute_command} from '../command_utils.js';
import {any_log_search_targets, mob_search_targets} from '../mc_sources.js';

import {make_spl} from './log.js';

const spl = make_spl('[SPL]');

const log_source = {
  search: 'search',
};

const search_radii = [32, 64, 128, 256, 511];

export function parse_search_command(action) {
  const match = action.trim().match(/^!search\("([^"]+)"\)$/);
  return match?.[1] ?? null;
}

export async function run_search(target, state, agent, log, start_attempt) {
  const concrete_items = expand_search_item(target);
  for (const item of concrete_items) {
    if (check_search_complete(item, state)) {
      spl.log(`Search fast-path: "${item}" already in state.`);
      return {found: true, message: null};
    }
  }

  let attempt = start_attempt;
  for (const radius of search_radii) {
    for (const item of concrete_items) {
      const command = make_search_command(item, radius);
      log.am(++attempt, command, null, {source: log_source.search});
      const {found, message} =
          await execute_search_command(agent, item, radius, command);
      if (found) return {found: true, message};
    }
  }

  return {found: false, message: null};
}

/**
 * Multi-target breadth-first search sweep. For each radius in
 * [32, 64, 128, 256, 511], attempts every still-active source before
 * incrementing the radius (per D4). Returns as soon as any source's
 * concrete member is found AND reached, or after all sources exhaust at
 * all radii.
 *
 * Abstract sources (e.g. `any_log`) are expanded via `expand_search_item`.
 * Unsupported abstracts (those that `expand_search_item` throws on) are
 * soft-skipped: logged once via `spl.warn` and treated as already-
 * exhausted for this sweep. The sweep continues with remaining sources
 * — a misconfigured graph can't crash the rollout.
 *
 * `search_found_not_reached` semantics: when the skill reports the target
 * was found but `check_search_complete` against fresh state shows it's
 * not in nearby (pathfinder failed mid-navigation), the source is marked
 * done for this sweep. Bigger radii won't help — the location is known;
 * pathfinder failure is the real issue.
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
 *   outcomes: { [source: string]: 'found_reached' | 'found_not_reached'
 *                                 | 'exhausted' | 'soft_skipped'
 *                                 | 'not_attempted' }
 * }>}
 */
export async function run_breadth_first_sweep(
    sources, agent, log, searched_targets, start_attempt) {
  // Per-source outcome tracking, surfaced in the return value so the
  // sweep handler can attach it to the task trace. Initialize every
  // source to 'not_attempted'; it gets overwritten as the source's fate
  // is determined.
  const outcomes = {};
  for (const source of sources) outcomes[source] = 'not_attempted';

  // Pre-expand sources; soft-skip unsupported abstracts.
  const expanded = [];
  for (const source of sources) {
    let items;
    try {
      items = expand_search_item(source);
    } catch (e) {
      spl.warn(`Sweep: unsupported abstract target "${source}" — skipping. ` +
               `Add expansion in expand_search_item. (${e.message})`);
      searched_targets.add(source);
      outcomes[source] = 'soft_skipped';
      continue;
    }
    expanded.push({source, items});
  }

  if (expanded.length === 0) {
    return {found: false, sources_exhausted: sources.slice(), outcomes};
  }

  // Fast path: any concrete item of any expanded source already nearby?
  const initial_state = get_am_state(agent);
  for (const {source, items} of expanded) {
    for (const item of items) {
      if (check_search_complete(item, initial_state)) {
        spl.log(`Sweep fast-path: "${item}" (from "${source}") already in state.`);
        outcomes[source] = 'found_reached';
        return {found: true, source, item, message: null, outcomes};
      }
    }
  }

  spl.log(`Sweep starting: sources=[${
      expanded.map(e => e.source).join(', ')}]`);

  // Active list: sources still being attempted at the next radius. Mutated
  // as targets are ruled out (search_found_not_reached). Snapshot via
  // .slice() before each radius pass so mid-radius removals don't disturb
  // iteration order.
  let active = expanded.slice();

  let attempt = start_attempt;
  for (const radius of search_radii) {
    for (const entry of active.slice()) {
      const {source, items} = entry;
      if (searched_targets.has(source)) continue;

      let target_done = false;
      for (const item of items) {
        const command = make_search_command(item, radius);
        log.am(++attempt, command, null, {source: log_source.search});
        const {found, message} =
            await execute_search_command(agent, item, radius, command);
        if (found) {
          if (check_search_complete(item, get_am_state(agent))) {
            // Target found AND reached. SPL outer loop can resume.
            outcomes[source] = 'found_reached';
            return {found: true, source, item, message, outcomes};
          }
          // search_found_not_reached: location known, pathfinder failed.
          // Bigger radii won't help — remove this source from active.
          spl.warn(`Sweep: "${item}" (from "${source}") found but bot did ` +
                   `not reach it. Marking source done for this sweep.`);
          searched_targets.add(source);
          outcomes[source] = 'found_not_reached';
          target_done = true;
          break;  // out of items loop
        }
      }
      if (target_done) {
        active = active.filter(e => e !== entry);
      }
    }
    if (active.length === 0) break;
  }

  // All remaining sources exhausted at radius 511.
  for (const {source} of active) {
    searched_targets.add(source);
    outcomes[source] = 'exhausted';
  }
  return {found: false, sources_exhausted: sources.slice(), outcomes};
}

async function execute_search_command(agent, item, radius, command) {
  spl.log(`Search (${item} r=${radius}):`, command);
  const result = await execute_command(agent, command);
  await sleep(500);
  spl.log('Search result:', result);

  const message =
      result?.message != null ? String(result.message).trim() : null;

  // Post-condition check: the only honest signal of "did this search
  // succeed" is whether the target is now in the bot's nearby state.
  // We deliberately ignore both the skill's `success` boolean and its
  // message text because:
  //   - The skill returns success=true with "Could not find" when
  //     nothing of that type exists in the radius (false positive).
  //   - The skill returns success=true with intermediate pathfinder
  //     warnings ("Path not found, but attempting to navigate anyway")
  //     followed by an actual "You have reached" success line —
  //     regex-on-message would misclassify these as failures.
  //   - When the pathfinder genuinely bails and the bot doesn't reach
  //     the target, the target won't be in nearby state. Same outcome.
  //
  // This subsumes the previous "Could not find" filter and the
  // pathfinder-bail regex reclassification for !searchForBlock /
  // !searchForEntity. `command_utils.js:NAVIGATION_ONLY_COMMANDS`
  // intentionally excludes these two skills.
  const found = check_search_complete(item, get_am_state(agent));

  if (found) spl.log(`Search succeeded: "${item}" at radius ${radius}.`);
  else spl.warn(`Search failed: "${item}" at radius ${radius}.`);
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
