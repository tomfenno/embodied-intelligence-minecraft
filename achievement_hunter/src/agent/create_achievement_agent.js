/**
 * Factory for launching an AchievementAgent connected to the Mindcraft server.
 * Equivalent to Mindcraft's createAgent() but uses AchievementAgentProcess
 * to spawn init_achievement_agent.js instead of init_agent.js.
 */

import {getServer} from '../../../src/mindcraft/mcserver.js';
import {registerAgent} from '../../../src/mindcraft/mindserver.js';

import {AchievementAgentProcess} from './achievement_agent_process.js';

const VIEWER_BASE_PORT = 3000;

let agent_count = 0;  // incremented per agent to assign unique viewer ports

/**
 * Registers, resolves server info, and starts the achievement agent process.
 * @param {object} settings - Full settings object; must include
 *     settings.profile.
 */
export async function create_achievement_agent(settings) {
  // Deep-clone to avoid mutating the caller's settings object.
  settings = structuredClone(settings);

  const agent_name = settings.profile.name;
  const agent_index = agent_count++;
  const viewer_port = VIEWER_BASE_PORT + agent_index;

  registerAgent(settings, viewer_port);

  try {
    const server = await getServer(
        settings.host, settings.port, settings.minecraft_version);
    settings.host = server.host;
    settings.port = server.port;
    settings.minecraft_version = server.version;
  } catch (error) {
    console.warn('Error getting server:', error);
    if (settings.minecraft_version === 'auto')
      settings.minecraft_version = null;
    console.warn('Attempting to connect anyway...');
  }

  const agent_process =
      new AchievementAgentProcess(agent_name, settings.mindserver_port);
  agent_process.start(settings.load_memory || false, agent_index);
}
