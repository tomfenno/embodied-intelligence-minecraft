import {executeCommand as execute_command} from '../../../../src/agent/commands/index.js';
import {any_log_search_targets, mob_search_targets} from '../mc_sources.js';

const spl = {
  log: (...args) => console.log('[SPL]', ...args),
  warn: (...args) => console.warn('[SPL]', ...args),
  error: (...args) => console.error('[SPL]', ...args),
};

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
      return true;
    }
  }

  let attempt = start_attempt;
  for (const radius of search_radii) {
    for (const item of concrete_items) {
      const command = make_search_command(item, radius);
      log.am(++attempt, command, null, {source: log_source.search});
      if (await execute_search_command(agent, item, radius, command))
        return true;
    }
  }

  return false;
}

async function execute_search_command(agent, item, radius, command) {
  spl.log(`Search (${item} r=${radius}):`, command);
  const result = await execute_command(agent, command);
  spl.log('Search result:', result);

  const found =
      result?.success === true && !result.message?.includes('Could not find');

  found ? spl.log(`Search succeeded: "${item}" at radius ${radius}.`) :
          spl.warn(`Search failed: "${item}" at radius ${radius}.`);
  return found;
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

export function make_search_command(target, radius) {
  return is_entity_target(target) ? `!searchForEntity("${target}", ${radius})` :
                                    `!searchForBlock("${target}", ${radius})`;
}
