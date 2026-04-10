import { registerAgent } from '../../src/mindcraft/mindserver.js';
import { getServer } from '../../src/mindcraft/mcserver.js';
import { AchievementAgentProcess } from './achievement_agent_process.js';

let agent_count = 0;

/**
 * Equivalent to Mindcraft.createAgent() but uses AchievementAgentProcess,
 * which spawns init_achievement_agent.js instead of init_agent.js.
 *
 * @param {object} settings - The full settings object (must have settings.profile set).
 */
export async function createAchievementAgent(settings) {
    settings = JSON.parse(JSON.stringify(settings));
    const agent_name = settings.profile.name;
    const agentIndex = agent_count++;
    const viewer_port = 3000 + agentIndex;

    registerAgent(settings, viewer_port);

    try {
        const server = await getServer(settings.host, settings.port, settings.minecraft_version);
        settings.host = server.host;
        settings.port = server.port;
        settings.minecraft_version = server.version;
    } catch (error) {
        console.warn('Error getting server:', error);
        if (settings.minecraft_version === 'auto') settings.minecraft_version = null;
        console.warn('Attempting to connect anyway...');
    }

    const agentProcess = new AchievementAgentProcess(agent_name, settings.mindserver_port);
    agentProcess.start(settings.load_memory || false, null, agentIndex);
}
