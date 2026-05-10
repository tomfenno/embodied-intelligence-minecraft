import {existsSync, readFileSync, writeFileSync} from 'fs';
import path from 'path';

export const BENCHMARK_TASK_TYPES = new Set(['inventory', 'advancement']);

const PROGRESS_FILE = './hells_kitchen_progress.json';

export const hellsKitchenProgressManager = {
  readProgress() {
    try {
      if (existsSync(PROGRESS_FILE)) {
        const data = readFileSync(PROGRESS_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (err) {
      console.error('Error reading progress file:', err);
    }
    return {taskId: null, agent0Complete: false, agent1Complete: false};
  },

  writeProgress(progress) {
    try {
      writeFileSync(PROGRESS_FILE, JSON.stringify(progress), 'utf8');
    } catch (err) {
      console.error('Error writing progress file:', err);
    }
  },

  resetTask(taskId) {
    const progress = {taskId, agent0Complete: false, agent1Complete: false};
    this.writeProgress(progress);
    return progress;
  },

  updateAgentProgress(taskId, agentId, isComplete) {
    const progress = this.readProgress();

    if (progress.taskId !== taskId) {
      progress.taskId = taskId;
      progress.agent0Complete = false;
      progress.agent1Complete = false;
    }

    if (agentId === 0) progress.agent0Complete = isComplete;
    if (agentId === 1) progress.agent1Complete = isComplete;

    this.writeProgress(progress);
    return progress;
  },
};

export function isBenchmarkTaskType(taskType) {
  return BENCHMARK_TASK_TYPES.has(taskType);
}

function isTargetDictionaryWithQuantities(target) {
  return typeof target === 'object' &&
      !Array.isArray(target) &&
      target !== null &&
      Object.values(target).every(value => typeof value === 'number');
}

function normalizeTargets(target) {
  if (typeof target === 'string') {
    return {[target]: 1};
  } else if (Array.isArray(target)) {
    return target.reduce((acc, item) => {
      acc[item] = 1;
      return acc;
    }, {});
  } else if (typeof target === 'object' && target !== null) {
    return target;
  }
  throw new Error('Invalid target format');
}

function normalizeQuantities(targets, quantities) {
  if (quantities === undefined) {
    return Object.keys(targets).reduce((acc, key) => {
      acc[key] = 1;
      return acc;
    }, {});
  } else if (typeof quantities === 'number') {
    return Object.keys(targets).reduce((acc, key) => {
      acc[key] = quantities;
      return acc;
    }, {});
  } else if (typeof quantities === 'object' && quantities !== null) {
    return quantities;
  }
  throw new Error('Invalid number_of_target format');
}

function getInventoryCount(agent) {
  const inventoryCount = {};
  agent.bot.inventory.slots.forEach((slot) => {
    if (slot) {
      const itemName = slot.name.toLowerCase();
      inventoryCount[itemName] = (inventoryCount[itemName] || 0) + slot.count;
    }
  });
  return inventoryCount;
}

function buildRequirementOption(option, defaultNumberOfTarget) {
  if (
    typeof option === 'object' &&
      option !== null &&
      !Array.isArray(option) &&
      ('target' in option || 'number_of_target' in option)
  ) {
    return {
      target: option.target,
      number_of_target: option.number_of_target,
    };
  }

  return {
    target: option,
    number_of_target: defaultNumberOfTarget,
  };
}

function getRequirementOptions(data) {
  if (Array.isArray(data.target_any_of) && data.target_any_of.length > 0) {
    return data.target_any_of.map((option) =>
      buildRequirementOption(option, data.number_of_target));
  }

  return [{
    target: data.target,
    number_of_target: data.number_of_target,
  }];
}

function evaluateInventoryRequirement(requirement, inventoryCount) {
  const targets = normalizeTargets(requirement.target);
  const requiredQuantities = isTargetDictionaryWithQuantities(requirement.target) ?
    requirement.target :
    normalizeQuantities(targets, requirement.number_of_target);

  const missingItems = [];
  let allTargetsMet = true;

  for (const [item, requiredCount] of Object.entries(requiredQuantities)) {
    const itemName = item.toLowerCase();
    const currentCount = inventoryCount[itemName] || 0;
    if (currentCount < requiredCount) {
      allTargetsMet = false;
      missingItems.push({
        item: itemName,
        required: requiredCount,
        current: currentCount,
        missing: requiredCount - currentCount,
      });
    }
  }

  return {
    success: allTargetsMet,
    missingItems,
  };
}

function scoreMissingItems(result) {
  return result.missingItems.reduce(
      (total, item) => total + (item.missing || 0), 0);
}

function evaluateRequirementOptions(data, inventoryCount) {
  const requirements = getRequirementOptions(data);
  let bestFailure = null;

  for (const requirement of requirements) {
    const result = evaluateInventoryRequirement(requirement, inventoryCount);
    if (result.success) {
      return result;
    }

    if (!bestFailure || scoreMissingItems(result) < scoreMissingItems(bestFailure)) {
      bestFailure = result;
    }
  }

  return bestFailure || {success: false, missingItems: []};
}

export function checkItemPresence(data, agent) {
  try {
    const inventoryCount = getInventoryCount(agent);

    if (
      data.task_id &&
        data.task_id.endsWith('hells_kitchen') &&
        Array.isArray(data.target) &&
        data.target.length === 2
    ) {
      const agentId = agent.count_id;

      if (agentId === 0 || agentId === 1) {
        const modifiedData = {
          ...data,
          target: data.target[agentId],
        };
        const agentResult =
            evaluateRequirementOptions(modifiedData, inventoryCount);
        const progress = hellsKitchenProgressManager.updateAgentProgress(
            data.task_id, agentId, agentResult.success);

        return {
          success: progress.agent0Complete && progress.agent1Complete,
          missingItems: agentResult.missingItems,
          agentComplete: agentResult.success,
        };
      }
    }

    return evaluateRequirementOptions(data, inventoryCount);
  } catch (error) {
    console.error('Error checking item presence:', error);
    return {
      success: false,
      missingItems: [],
      error: error.message,
    };
  }
}

export class InventoryTaskValidator {
  constructor(data, agent) {
    this.data = data;
    this.agent = agent;
  }

  validate() {
    const result = checkItemPresence(this.data, this.agent);
    return {
      valid: result.success,
      score: result.success ? 1 : 0,
    };
  }
}

export function readAdvancementTaskState(
    agentName, advancementId,
    {
      serverRoot = process.env.TASK_SERVER_ROOT,
      worldPath = process.env.TASK_WORLD_PATH,
    } = {}) {
  if (!agentName || !advancementId || !serverRoot || !worldPath) {
    return {
      success: false,
      reason: 'missing_context',
    };
  }

  const usercachePath = path.join(serverRoot, 'usercache.json');
  if (!existsSync(usercachePath)) {
    return {
      success: false,
      reason: 'missing_usercache',
      usercachePath,
    };
  }

  let usercache = [];
  try {
    usercache = JSON.parse(readFileSync(usercachePath, 'utf8'));
  } catch (error) {
    return {
      success: false,
      reason: 'invalid_usercache',
      error: error.message,
      usercachePath,
    };
  }

  const userEntry = usercache.find((entry) => entry?.name === agentName);
  if (!userEntry?.uuid) {
    return {
      success: false,
      reason: 'missing_usercache_entry',
      usercachePath,
    };
  }

  const advancementFilePath =
      path.join(worldPath, 'advancements', `${userEntry.uuid}.json`);
  if (!existsSync(advancementFilePath)) {
    return {
      success: false,
      reason: 'missing_advancement_file',
      advancementFilePath,
      uuid: userEntry.uuid,
    };
  }

  let advancementData = {};
  try {
    advancementData = JSON.parse(readFileSync(advancementFilePath, 'utf8'));
  } catch (error) {
    return {
      success: false,
      reason: 'invalid_advancement_file',
      advancementFilePath,
      error: error.message,
      uuid: userEntry.uuid,
    };
  }

  const advancementState = advancementData[advancementId];
  const done = advancementState?.done === true;
  return {
    success: done,
    reason: done ? 'complete' : 'incomplete',
    advancementFilePath,
    uuid: userEntry.uuid,
  };
}

export class AdvancementTaskValidator {
  constructor(data, agent) {
    this.data = data;
    this.agent = agent;
  }

  validate() {
    const result = readAdvancementTaskState(
        this.agent.name, this.data.advancement_id);
    return {
      valid: result.success,
      score: result.success ? 1 : 0,
    };
  }
}
