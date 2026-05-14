/**
 * Achievement Hunter mode definitions.
 *
 * Forked from src/agent/modes.js to tune behaviour for the SPL without
 * touching the base Mindcraft code.
 *
 * Changes vs upstream:
 *   - lava_sneak: new passive mode — sneaks whenever lava is adjacent
 * (horizontal, diagonal, or below an adjacent edge) so the bot doesn't fall in.
 * Replaces the hardcoded is_lava_useOn sneak guards that were scattered across
 * the SPL.
 *   - unstuck: try/finally around moveAway so the 10-second kill timer is
 *     always cleared even when interrupted mid-pathfind (PathStopped would
 *     otherwise skip clearTimeout and fire agent.cleanKill).
 *   - ModeController: agent passed via constructor instead of module-level
 *     global.
 */

import * as skills from '../../../src/agent/library/skills.js';
import * as world from '../../../src/agent/library/world.js';
import settings from '../../../src/agent/settings.js';
import * as mc from '../../../src/utils/mcdata.js';
// PR-A-D verification
import {verify_log} from '../pipeline/structured_loop/_pr_a_d_verify_log.js';

/**
 * Returns true if the bot is in water by any of four signals: the physics
 * engine's bounding-box test, or water blocks at feet / head / one-below.
 * Mirrors the check in skills.goToNearestLand and the !goToNearestLand
 * verifier so all three agree on what "in water" means. The fallbacks
 * catch the chunk-not-loaded case where blockAt defaults to null and
 * the physics test may not register.
 */
function is_in_water(bot) {
  const pos = bot.entity.position;
  return !!bot.entity.isInWater
      || bot.blockAt(pos)?.name === 'water'
      || bot.blockAt(pos.offset(0, 1, 0))?.name === 'water'
      || bot.blockAt(pos.offset(0, -1, 0))?.name === 'water';
}

/**
 * Returns true if lava is within one block of the bot in any direction that
 * poses a fall-in risk: horizontally adjacent, diagonally adjacent (same Y),
 * or one block below an adjacent edge.
 */
function is_lava_adjacent(bot) {
  const pos = bot.entity.position;
  const offsets = [
    // Horizontal adjacency at feet Y
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
    // Diagonal adjacency at feet Y
    [1, 0, 1],
    [1, 0, -1],
    [-1, 0, 1],
    [-1, 0, -1],
    // Below adjacent edges — cardinal
    [1, -1, 0],
    [-1, -1, 0],
    [0, -1, 1],
    [0, -1, -1],
    // Below adjacent edges — diagonal
    [1, -1, 1],
    [1, -1, -1],
    [-1, -1, 1],
    [-1, -1, -1],
  ];
  return offsets.some(([dx, dy, dz]) => {
    const block = bot.blockAt(pos.offset(dx, dy, dz));
    return block?.name === 'lava';
  });
}

/**
 * Appends to the behavior log and, if narration is enabled, echoes to in-game
 * chat.
 */
async function say(agent, message) {
  agent.bot.modes.behavior_log += message + '\n';
  if (agent.shut_up || !settings.narrate_behavior) return;
  agent.openChat(message);
}

const modes_list = [
  {
    name: 'self_preservation',
    description:
        'Respond to drowning, burning, and damage at low health. Interrupts all actions.',
    interrupts: ['all'],
    on: true,
    active: false,
    fall_blocks: [
      'sand', 'gravel', 'concrete_powder'
    ],  // includes matching substrings like 'sandstone' and 'red_sand'
    update: async function(agent) {
      const bot = agent.bot;
      let block = bot.blockAt(bot.entity.position);
      let blockAbove = bot.blockAt(bot.entity.position.offset(0, 1, 0));
      if (!block)
        block = {name: 'air'};  // hacky fix when blocks are not loaded
      if (!blockAbove) blockAbove = {name: 'air'};
      const drowning = blockAbove.name === 'water'
          || (is_in_water(bot) && bot.oxygenLevel != null && bot.oxygenLevel < 20);
      if (drowning) {
        // does not call execute so does not interrupt other actions
        if (!bot.pathfinder.goal) {
          bot.setControlState('jump', true);
        }
      } else if (
          this.fall_blocks.some(name => blockAbove.name.includes(name))) {
        bot.setControlState('sneak', false);
        bot.modes.recordTrigger('self_preservation',
            {reason: 'falling_block_above', block: blockAbove.name});
        execute(this, agent, async () => {
          await skills.moveAway(bot, 2);
        });
      } else if (
          block.name === 'lava' || block.name === 'fire' ||
          blockAbove.name === 'lava' || blockAbove.name === 'fire') {
        say(agent, 'I\'m on fire!');
        bot.setControlState('sneak', false);
        const burning_source = block.name === 'lava' ? 'lava'
            : block.name === 'fire' ? 'fire'
            : blockAbove.name === 'lava' ? 'lava_above'
            : 'fire_above';
        bot.modes.recordTrigger(
            'self_preservation', {reason: 'burning', source: burning_source});
        // if you have a water bucket, use it
        let waterBucket =
            bot.inventory.items().find(item => item.name === 'water_bucket');
        if (waterBucket) {
          execute(this, agent, async () => {
            let success = await skills.placeBlock(
                bot, 'water_bucket', block.position.x, block.position.y,
                block.position.z);
            if (success) say(agent, 'Placed some water, ahhhh that\'s better!');
          });
        } else {
          execute(this, agent, async () => {
            let waterBucket = bot.inventory.items().find(
                item => item.name === 'water_bucket');
            if (waterBucket) {
              let success = await skills.placeBlock(
                  bot, 'water_bucket', block.position.x, block.position.y,
                  block.position.z);
              if (success)
                say(agent, 'Placed some water, ahhhh that\'s better!');
              return;
            }
            let nearestWater = world.getNearestBlock(bot, 'water', 20);
            if (nearestWater) {
              const pos = nearestWater.position;
              let success =
                  await skills.goToPosition(bot, pos.x, pos.y, pos.z, 0.2);
              if (success)
                say(agent, 'Found some water, ahhhh that\'s better!');
              return;
            }
            await skills.moveAway(bot, 5);
          });
        }
      } else if (
          Date.now() - bot.lastDamageTime < 3000 &&
          (bot.health < 5 || bot.lastDamageTaken >= bot.health)) {
        say(agent, 'I\'m dying!');
        bot.setControlState('sneak', false);
        bot.modes.recordTrigger('self_preservation', {
          reason: 'low_health',
          health: bot.health,
          last_damage: bot.lastDamageTaken,
        });
        execute(this, agent, async () => {
          await skills.moveAway(bot, 20);
        });
      } else if (agent.isIdle()) {
        bot.clearControlStates();  // clear jump if not in danger or doing
                                   // anything else
      }
    }
  },
  {
    name: 'unstuck',
    description:
        'Attempt to get unstuck when in the same place for a while. Interrupts some actions.',
    interrupts: ['all'],
    // Crafting and smelting place workstations that must be collected on
    // completion; interrupting them would strand the block in the world.
    no_interrupt: ['action:craftRecipe', 'action:smeltItem'],
    on: true,
    active: false,
    prev_location: null,
    distance: 2,
    stuck_time: 0,
    last_time: Date.now(),
    max_stuck_time: 20,
    prev_dig_block: null,
    update: async function(agent) {
      if (agent.isIdle()) {
        this.prev_location = null;
        this.stuck_time = 0;
        return;
      }
      const bot = agent.bot;
      const cur_dig_block = bot.targetDigBlock;
      if (cur_dig_block && !this.prev_dig_block) {
        this.prev_dig_block = cur_dig_block;
      }
      if (this.prev_location &&
          this.prev_location.distanceTo(bot.entity.position) < this.distance &&
          cur_dig_block == this.prev_dig_block) {
        this.stuck_time += (Date.now() - this.last_time) / 1000;
      } else {
        this.prev_location = bot.entity.position.clone();
        this.stuck_time = 0;
        this.prev_dig_block = null;
      }
      const max_stuck_time = cur_dig_block?.name === 'obsidian' ?
          this.max_stuck_time * 2 :
          this.max_stuck_time;
      if (this.stuck_time > max_stuck_time) {
        say(agent, 'I\'m stuck!');
        bot.modes.recordTrigger('unstuck', {
          reason: 'stuck',
          dig: cur_dig_block?.name ?? null,
          stuck_for_s: Math.round(this.stuck_time),
        });
        this.stuck_time = 0;
        execute(this, agent, async () => {
          // try/finally ensures the kill timer clears even on PathStopped
          // interruption.
          const crash_timeout = setTimeout(() => {
            agent.cleanKill('Got stuck and couldn\'t get unstuck');
          }, 10000);
          try {
            await skills.moveAway(bot, 5);
            say(agent, 'I\'m free.');
          } finally {
            clearTimeout(crash_timeout);
          }
        });
      }
      this.last_time = Date.now();
    },
    unpause: function() {
      this.prev_location = null;
      this.stuck_time = 0;
      this.prev_dig_block = null;
    }
  },
  // Unchanged from upstream modes.js — untested with AH_Bot.
  {
    name: 'cowardice',
    description: 'Run away from enemies. Interrupts all actions.',
    interrupts: ['all'],
    on: true,
    active: false,
    update: async function(agent) {
      const enemy = world.getNearestEntityWhere(
          agent.bot, entity => mc.isHostile(entity), 16);
      if (enemy && await world.isClearPath(agent.bot, enemy)) {
        say(agent, `Aaa! A ${enemy.name.replace('_', ' ')}!`);
        execute(this, agent, async () => {
          await skills.avoidEnemies(agent.bot, 24);
        });
      }
    }
  },
  {
    name: 'self_defense',
    description: 'Attack nearby enemies. Interrupts all actions.',
    interrupts: ['all'],
    on: true,
    active: false,
    update: async function(agent) {
      const enemy = world.getNearestEntityWhere(
          agent.bot, entity => mc.isHostile(entity), 8);
      if (enemy && await world.isClearPath(agent.bot, enemy)) {
        say(agent, `Fighting ${enemy.name}!`);
        agent.bot.modes.recordTrigger(
            'self_defense', {reason: 'hostile_nearby', enemy: enemy.name});
        execute(this, agent, async () => {
          await skills.defendSelf(agent.bot, 8);
        });
      }
    }
  },
  {
    name: 'lava_sneak',
    description:
        'Sneak when lava is adjacent to prevent falling in. Does not interrupt actions.',
    interrupts: ['all'],
    on: true,
    active: false,
    update: function(agent) {
      const bot = agent.bot;
      const block = bot.blockAt(bot.entity.position);
      if (block?.name === 'lava') {
        // Already in lava — clear sneak so self_preservation can sprint to
        // escape unimpeded.
        bot.setControlState('sneak', false);
        return;
      }
      if (bot.pathfinder.goal) {
        // Pathfinder is actively navigating — it handles lava avoidance via
        // cost map. External sneak breaks jump timing near lava edges.
        bot.setControlState('sneak', false);
        return;
      }
      if (is_lava_adjacent(bot)) {
        bot.setControlState('sneak', true);
      } else {
        bot.setControlState('sneak', false);
      }
    }
  },
  // Unchanged from upstream modes.js — untested with AH_Bot.
  {
    name: 'hunting',
    description: 'Hunt nearby animals when idle.',
    interrupts: ['action:followPlayer'],
    on: true,
    active: false,
    update: async function(agent) {
      const huntable = world.getNearestEntityWhere(
          agent.bot, entity => mc.isHuntable(entity), 8);
      if (huntable && await world.isClearPath(agent.bot, huntable)) {
        execute(this, agent, async () => {
          say(agent, `Hunting ${huntable.name}!`);
          await skills.attackEntity(agent.bot, huntable);
        });
      }
    }
  },
  {
    name: 'item_collecting',
    description: 'Collect nearby items when idle.',
    interrupts: ['action:followPlayer'],
    on: true,
    active: false,
    wait: 2,
    prev_item: null,
    noticed_at: -1,
    update: async function(agent) {
      const item = world.getNearestEntityWhere(
          agent.bot, entity => entity.name === 'item', 8);
      const empty_inv_slots = agent.bot.inventory.emptySlotCount();
      if (item && item !== this.prev_item &&
          await world.isClearPath(agent.bot, item) && empty_inv_slots > 1) {
        if (this.noticed_at === -1) {
          this.noticed_at = Date.now();
        }
        if (Date.now() - this.noticed_at > this.wait * 1000) {
          say(agent, `Picking up item!`);
          this.prev_item = item;
          execute(this, agent, async () => {
            await skills.pickupNearbyItems(agent.bot);
          });
          this.noticed_at = -1;
        }
      } else {
        this.noticed_at = -1;
      }
    }
  },
  // Unchanged from upstream modes.js — untested with AH_Bot.
  {
    name: 'torch_placing',
    description: 'Place torches when idle and there are no torches nearby.',
    interrupts: ['action:followPlayer'],
    on: true,
    active: false,
    cooldown: 5,
    last_place: Date.now(),
    update: function(agent) {
      if (world.shouldPlaceTorch(agent.bot)) {
        if (Date.now() - this.last_place < this.cooldown * 1000) return;
        execute(this, agent, async () => {
          const pos = agent.bot.entity.position;
          await skills.placeBlock(
              agent.bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
        });
        this.last_place = Date.now();
      }
    }
  },
  {
    name: 'elbow_room',
    description: 'Move away from nearby players when idle.',
    interrupts: ['action:followPlayer'],
    on: true,
    active: false,
    distance: 0.5,
    update: async function(agent) {
      const player = world.getNearestEntityWhere(
          agent.bot, entity => entity.type === 'player', this.distance);
      if (player) {
        execute(this, agent, async () => {
          const wait_time = Math.random() * 1000;
          await new Promise(resolve => setTimeout(resolve, wait_time));
          if (player.position.distanceTo(agent.bot.entity.position) <
              this.distance) {
            await skills.moveAwayFromEntity(agent.bot, player, this.distance);
          }
        });
      }
    }
  },
  // Unchanged from upstream modes.js — untested with AH_Bot.
  {
    name: 'idle_staring',
    description: 'Animation to look around at entities when idle.',
    interrupts: [],
    on: true,
    active: false,
    staring: false,
    last_entity: null,
    next_change: 0,
    update: function(agent) {
      const entity = agent.bot.nearestEntity();
      let entity_in_view = entity &&
          entity.position.distanceTo(agent.bot.entity.position) < 10 &&
          entity.name !== 'enderman';
      if (entity_in_view && entity !== this.last_entity) {
        this.staring = true;
        this.last_entity = entity;
        this.next_change = Date.now() + Math.random() * 1000 + 4000;
      }
      if (entity_in_view && this.staring) {
        let isbaby = entity.type !== 'player' && entity.metadata[16];
        let height = isbaby ? entity.height / 2 : entity.height;
        agent.bot.lookAt(entity.position.offset(0, height, 0));
      }
      if (!entity_in_view) this.last_entity = null;
      if (Date.now() > this.next_change) {
        this.staring = Math.random() < 0.3;
        if (!this.staring) {
          const yaw = Math.random() * Math.PI * 2;
          const pitch = (Math.random() * Math.PI / 2) - Math.PI / 4;
          agent.bot.look(yaw, pitch, false);
        }
        this.next_change = Date.now() + Math.random() * 10000 + 2000;
      }
    }
  },
  // Unchanged from upstream modes.js — untested with AH_Bot.
  {
    name: 'cheat',
    description: 'Use cheats to instantly place blocks and teleport.',
    interrupts: [],
    on: false,
    active: false,
    update: function(agent) { /* do nothing */
    }
  },
];

async function execute(mode, agent, func, timeout = -1) {
  if (agent.self_prompter.isActive()) agent.self_prompter.stopLoop();
  mode.active = true;
  const code_return =
      await agent.actions.runAction(`mode:${mode.name}`, async () => {
        await func();
      }, {timeout});
  mode.active = false;
  console.log(`Mode ${mode.name} finished executing, code_return: ${
      code_return.message}`);
}

const modes_map = {};
for (const mode of modes_list) {
  modes_map[mode.name] = mode;
}

/**
 * Controls which autonomous modes are active and drives their per-tick updates.
 * Mirrors the base ModeController API so base agent.js can call it on
 * bot.modes.
 */
class ModeController {
  constructor(agent) {
    this._agent = agent;
    this.behavior_log = '';
    // Per-mode trigger reason map, written by each mode right before it
    // calls execute() and read by command_utils.js when building the
    // `mode_interrupted` result message. Keyed by mode name; values are
    // small plain objects like {reason: 'stuck', dig: 'stone'}.
    // Survives only until the next time the same mode fires (overwrite
    // semantics) — there's no per-firing history.
    this._last_trigger = {};
  }

  /**
   * Record why a mode is firing. Called from inside each mode's update
   * function immediately before execute(). The recorded reason is then
   * read by command_utils.js to enrich the `mode_interrupted` action
   * result with `(reason=<kind>, <detail>=<value>)` per mode.
   *
   * Defensive: a buggy or unknown mode name is silently accepted; the
   * map just grows by one entry. The reader treats missing entries as
   * "no reason recorded".
   */
  recordTrigger(mode_name, reason_obj) {
    if (typeof mode_name !== 'string' || mode_name.length === 0) return;
    this._last_trigger[mode_name] =
        reason_obj && typeof reason_obj === 'object' ? reason_obj : null;
    // PR-A-D verification
    verify_log('mode_trigger',
        {mode: mode_name, reason: reason_obj ?? null});
  }

  /**
   * Read the most recent trigger reason for a mode, or null when none
   * has been recorded since process start. Pure read — does not clear
   * the slot.
   */
  getLastTrigger(mode_name) {
    return this._last_trigger?.[mode_name] ?? null;
  }

  exists(mode_name) {
    return modes_map[mode_name] != null;
  }
  setOn(mode_name, on) {
    modes_map[mode_name].on = on;
  }
  isOn(mode_name) {
    return modes_map[mode_name].on;
  }
  pause(mode_name) {
    modes_map[mode_name].paused = true;
  }

  unpause(mode_name) {
    const mode = modes_map[mode_name];
    if (mode.unpause && mode.paused) mode.unpause();
    mode.paused = false;
  }

  unPauseAll() {
    for (const mode of modes_list) {
      if (mode.paused) console.log(`Unpausing mode ${mode.name}`);
      this.unpause(mode.name);
    }
  }

  isAnyModeActive() {
    return modes_list.some(m => m.active);
  }

  getActiveModeNames() {
    return modes_list.filter(m => m.active).map(m => m.name);
  }

  async waitForIdle(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.isAnyModeActive()) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }

  getMiniDocs() {
    let res = 'Agent Modes:';
    for (const mode of modes_list) {
      res += `\n- ${mode.name}(${mode.on ? 'ON' : 'OFF'})`;
    }
    return res;
  }

  getDocs() {
    let res = 'Agent Modes:';
    for (const mode of modes_list) {
      res += `\n- ${mode.name}(${mode.on ? 'ON' : 'OFF'}): ${mode.description}`;
    }
    return res;
  }

  async update() {
    if (this._agent.isIdle()) this.unPauseAll();
    for (const mode of modes_list) {
      const current = this._agent.actions.currentActionLabel;
      const interruptible = mode.interrupts.some(i => i === 'all') ||
          mode.interrupts.some(i => i === current);
      const blocked = mode.no_interrupt?.some(i => i === current) ?? false;
      if (mode.on && !mode.paused && !mode.active && !blocked &&
          (this._agent.isIdle() || interruptible)) {
        await mode.update(this._agent);
      }
      if (mode.active) break;
    }
  }

  flushBehaviorLog() {
    const log = this.behavior_log;
    this.behavior_log = '';
    return log;
  }

  getJson() {
    const res = {};
    for (const mode of modes_list) res[mode.name] = mode.on;
    return res;
  }

  loadJson(json) {
    for (const mode of modes_list) {
      if (json[mode.name] != undefined) mode.on = json[mode.name];
    }
  }
}

/**
 * Installs a ModeController on bot.modes and applies any initial mode config
 * from the profile.
 */
export function init_ah_modes(agent) {
  agent.bot.modes = new ModeController(agent);
  if (agent.task) {
    agent.bot.restrict_to_inventory = agent.task.restrict_to_inventory;
  }
  const modes_json = agent.prompter.getInitModes();
  if (modes_json) {
    agent.bot.modes.loadJson(modes_json);
  }
}
