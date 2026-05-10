import {executeCommand} from '../commands/index.js';
import {getPosition} from '../library/world.js';
import settings from '../settings.js';
import {ConstructionTaskValidator, Blueprint} from './construction_tasks.js';
import {CookingTaskInitiator} from './cooking_tasks.js';
import {
  AdvancementTaskValidator,
  InventoryTaskValidator,
  hellsKitchenProgressManager,
  isBenchmarkTaskType,
} from '../../../achievement_hunter/evaluation_harness/task_validators.js';

export class Task {
  constructor(agent, task_data, taskStartTime = null) {
    this.agent = agent;
    this.data = null;
    if (taskStartTime !== null) {
      this.taskStartTime = taskStartTime;
    } else {
      this.taskStartTime = Date.now();
    }
    this.validator = null;
    this.reset_function = null;
    this.blocked_actions = [];
    this.task_data = task_data;
    if (task_data) {
      console.log('Starting task', task_data.task_id);
      console.log('Task start time set to', this.taskStartTime);
      if (task_data.task_id.endsWith('hells_kitchen')) {
        hellsKitchenProgressManager.resetTask(task_data.task_id);
        console.log('Reset Hells Kitchen progress for new task');
      }
      this.data = task_data;
      this.task_type = this.data.type;
      if (this.task_type === 'construction' && this.data.blueprint) {
        this.blueprint = new Blueprint(this.data.blueprint);
        this.goal = this.data.goal + ' \n' + this.blueprint.explain() +
            ' \nmake sure to place the lower levels of the blueprint first';
        this.conversation =
            this.data.conversation + ' \n' + this.blueprint.explain();
      } else {
        this.goal = this.data.goal;
        this.conversation = this.data.conversation;
      }
      this.taskTimeout = this.data.timeout || 300;

      if (this.task_type === 'construction') {
        this.validator = new ConstructionTaskValidator(this.data, this.agent);
      } else if (
        this.task_type === 'cooking' ||
          this.task_type === 'techtree' ||
          this.task_type === 'inventory'
      ) {
        this.validator = new InventoryTaskValidator(this.data, this.agent);
      } else if (this.task_type === 'advancement') {
        this.validator = new AdvancementTaskValidator(this.data, this.agent);
      } else {
        this.validator = null;
      }

      if (this.data.blocked_actions) {
        this.blocked_actions =
            this.data.blocked_actions[this.agent.count_id.toString()] || [];
      } else {
        this.blocked_actions = [];
      }
      this.restrict_to_inventory = !!this.data.restrict_to_inventory;
      if (this.data.goal) this.blocked_actions.push('!endGoal');
      if (this.conversation) this.blocked_actions.push('!endConversation');
    } else {
      console.log('No task.');
    }

    this.name = this.agent.name;
    this.available_agents = [];
  }

  updateAvailableAgents(agents) {
    this.available_agents = agents;
  }

  resetHellsKitchenProgress() {
    if (this.task_id && this.task_id.endsWith('hells_kitchen')) {
      hellsKitchenProgressManager.resetTask(this.task_id);
      console.log('Hells Kitchen progress reset manually');
    }
  }

  getAgentGoal() {
    if (!this.data || !this.data.goal) {
      return null;
    }

    let add_string = '';

    if (this.task_type === 'cooking') {
      if (this.data.agent_count > 2) {
        if (this.name.toLowerCase().startsWith('andy')) {
          add_string =
              '\nIn the end, all the food items should be given to you by other bots. Make sure to talk to all the agents using startConversation command to coordinate the task instead of talking to just one agent. You can even end current conversation with any agent using endConversation command and then talk to a new agent using startConversation command.';
        } else {
          add_string =
              '\nIn the end, all the food items should be given to one single bot whose name starts with andy or Andy. Make sure to talk to all the agents using startConversation command to coordinate the task instead of talking to just one agent. You can even end current conversation with any agent using endConversation command and then talk to a new agent using startConversation command.';
        }
      } else if (
        !this.data.task_id ||
          !this.data.task_id.endsWith('hells_kitchen')
      ) {
        add_string =
            '\nIn the end, all the food items should be given to one single bot.';
      }
    }

    if (this.task_type === 'techtree' && this.data.agent_count > 2) {
      add_string =
          '\nMake sure to share resources among all agents and to talk to all the agents using startConversation command to coordinate the task instead of talking to just one agent. You can even end current conversation with any agent using endConversation command and then talk to a new agent using startConversation command.';
    }

    if (typeof this.data.goal === 'string') {
      return this.data.goal + add_string;
    }

    if (typeof this.data.goal === 'object' && this.data.goal !== null) {
      const agentId = this.agent.count_id.toString();
      return (this.data.goal[agentId] || '') + add_string;
    }

    return null;
  }

  isDone() {
    let res = null;
    if (this.validator) res = this.validator.validate();
    if (res && res.valid) {
      if (!isBenchmarkTaskType(this.task_type)) {
        for (const agent of this.available_agents) {
          this.agent.bot.chat(`/clear ${agent}`);
        }
      }
      return {message: 'Task successful', score: res.score};
    }

    const elapsedTime = (Date.now() - this.taskStartTime) / 1000;

    if (this.data.agent_count > 1 &&
        elapsedTime >= 30 &&
        this.available_agents.length !== this.data.agent_count) {
      console.log('No other agents found. Task unsuccessful.');
      return {message: 'No other agents found', score: 0};
    }

    if (this.taskTimeout && elapsedTime >= this.taskTimeout) {
      console.log('Task timeout reached. Task unsuccessful.');
      if (res) {
        return {message: 'Task timeout reached', score: res.score};
      }
      return {message: 'Task timeout reached', score: 0};
    }
    return false;
  }

  async setAgentGoal() {
    if (settings.achievement_hunter && isBenchmarkTaskType(this.task_type)) {
      return;
    }

    let agentGoal = this.getAgentGoal();
    const humanCount = this.data.human_count || 0;
    if (agentGoal && this.data.agent_count + humanCount > 1) {
      agentGoal += 'You have to collaborate with other agents/bots, namely ' +
          this.available_agents.filter((n) => n !== this.name).join(', ') +
          ' to complete the task as soon as possible by dividing the work among yourselves.';
      console.log(
          `Setting goal for agent ${this.agent.count_id}: ${agentGoal}`);
    }
    await executeCommand(this.agent, `!goal("${agentGoal}")`);
  }

  async initBotTask() {
    if (isBenchmarkTaskType(this.task_type)) {
      return;
    }

    await this.agent.bot.chat(`/clear ${this.name}`);
    console.log(`Cleared ${this.name}'s inventory.`);

    await new Promise((resolve) => setTimeout(resolve, 500));

    if (this.data === null) return;

    if (this.task_type === 'cooking') {
      this.initiator = new CookingTaskInitiator(this.data, this.agent.bot);
    } else {
      this.initiator = null;
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));

    const humanCount = this.data.human_count || 0;
    if (this.agent.count_id === 0 && humanCount > 0) {
      console.log('Clearing human player inventories');
      for (let i = 0; i < humanCount; i++) {
        const username = this.data.usernames[i];
        await this.agent.bot.chat(`/clear ${username}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (this.data.initial_inventory) {
      console.log('Setting inventory...');
      let initialInventory = {};

      initialInventory =
          this.data.initial_inventory[this.agent.count_id.toString()] || {};
      console.log(
          'Initial inventory for agent', this.agent.count_id, ':',
          initialInventory);
      console.log('');

      if (humanCount > 0 && this.agent.count_id === 0) {
        if (humanCount !== this.data.usernames.length) {
          console.log(
              `Number of human players ${humanCount} does not match the number of usernames provided. ${this.data.usernames.length}`);
          throw new Error(
              `Number of human players ${humanCount} does not match the number of usernames provided. ${this.data.usernames.length}`);
        }

        const starting_idx = this.data.agent_count;
        for (let i = 0; i < humanCount; i++) {
          const username = this.data.usernames[i];
          const inventory = this.data.initial_inventory[starting_idx + i];
          console.log(Object.keys(inventory));
          for (const key of Object.keys(inventory)) {
            const itemName = key.toLowerCase();
            const quantity = inventory[key];
            console.log(`Give ${username} ${quantity} ${itemName}`);
            await this.agent.bot.chat(`/give ${username} ${itemName} ${quantity}`);
          }
        }
      }
      console.log(this.data.initial_inventory);

      for (const key of Object.keys(initialInventory)) {
        const itemName = key.toLowerCase();
        const quantity = initialInventory[key];
        await this.agent.bot.chat(`/give ${this.name} ${itemName} ${quantity}`);
        console.log(`Gave ${this.name} ${quantity} ${itemName}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (this.initiator && this.agent.count_id === 0) {
      await this.initiator.init();
    }

    await this.teleportBots();

    if (this.data.agent_count && this.data.agent_count > 1) {
      await new Promise((resolve) => setTimeout(resolve, 10000));
      if (this.available_agents.length < this.data.agent_count) {
        console.log(
            `Missing ${
                this.data.agent_count - this.available_agents.length} bot(s).`);
        this.agent.killAll();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (this.data.conversation && this.agent.count_id === 0) {
      let other_name = this.available_agents.filter((n) => n !== this.name)[0];
      let waitCount = 0;
      while (other_name === undefined && waitCount < 20) {
        other_name = this.available_agents.filter((n) => n !== this.name)[0];
        await new Promise((resolve) => setTimeout(resolve, 1000));
        waitCount++;
      }
      if (other_name === undefined && this.data.agent_count > 1) {
        console.log('No other agents found. Task unsuccessful.');
        this.agent.killAll();
      }
      await executeCommand(
          this.agent,
          `!startConversation("${other_name}", "${this.data.conversation}")`);
    }
    await this.setAgentGoal();
  }

  async teleportBots() {
    console.log('\n\nTeleporting bots');
    function getRandomOffset(range) {
      return Math.floor(Math.random() * (range * 2 + 1)) - range;
    }

    let human_player_name = null;
    const bot = this.agent.bot;

    for (const playerName in bot.players) {
      const player = bot.players[playerName];
      if (!this.available_agents.some((n) => n === playerName)) {
        console.log('Found human player:', player.username);
        human_player_name = player.username;
        break;
      }
    }

    if (human_player_name && (this.data.human_count || 0) === 0) {
      console.log(`Teleporting ${this.name} to human ${human_player_name}`);
      bot.chat(`/tp ${this.name} ${human_player_name}`);
    } else {
      console.log(`Teleporting ${this.name} to ${this.available_agents[0]}`);
      bot.chat(`/tp ${this.name} ${this.available_agents[0]}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 200));

    if (this.data.type !== 'construction') {
      const pos = getPosition(bot);
      const xOffset = getRandomOffset(5);
      const zOffset = getRandomOffset(5);
      bot.chat(`/tp ${this.name} ${Math.floor(pos.x + xOffset)} ${pos.y + 3} ${
          Math.floor(pos.z + zOffset)}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    if (this.data.agent_count && this.data.agent_count > 1) {
      await new Promise((resolve) => setTimeout(resolve, 10000));
      if (this.available_agents.length < this.data.agent_count) {
        console.log(
            `Missing ${
                this.data.agent_count - this.available_agents.length} bot(s).`);
        this.agent.killAll();
      }
    }

    if (this.data.type === 'construction') {
      if (this.blueprint) {
        console.log('Cleaning out construction blueprint');
        const result = this.blueprint.autoDelete();
        const commands = result.commands;
        const nearbyPosition = result.nearbyPosition;
        console.log('nearby position', nearbyPosition);
        const first_coord = this.data.blueprint.levels[0].coordinates;
        bot.chat(`/tp @a ${first_coord[0]} ${first_coord[1]} ${first_coord[2]}`);
        if (this.agent.agent_id === 0 && (this.data.human_count || 0) > 0) {
          for (let i = 0; i < this.data.human_count; i++) {
            const username = this.data.usernames[i];
            await bot.chat(`/tp ${username} ${nearbyPosition.x} ${
                nearbyPosition.y} ${nearbyPosition.z}`);
          }
        }
        for (const command of commands) {
          bot.chat(command);
        }
      } else {
        console.log('no construction blueprint?');
      }
    }
  }
}
