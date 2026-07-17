import {existsSync, readFileSync, writeFileSync} from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USAGE_FILENAME = 'episode_llm_usage.json';

let pricingTable = null;
function loadPricingTable() {
  if (pricingTable) return pricingTable;
  try {
    const pricingPath = path.join(__dirname, 'model_pricing.json');
    pricingTable = JSON.parse(readFileSync(pricingPath, 'utf8'));
  } catch (error) {
    console.error('Failed to read model_pricing.json:', error);
    pricingTable = {};
  }
  return pricingTable;
}

function getUsagePath() {
  if (!process.env.BENCHMARK_EPISODE_DIR) {
    return null;
  }
  return path.join(process.env.BENCHMARK_EPISODE_DIR, USAGE_FILENAME);
}

function readUsageState(usagePath) {
  if (!usagePath || !existsSync(usagePath)) {
    return {
      total_requests: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cached_input_tokens: 0,
      total_cost_usd: 0,
      by_agent: {},
    };
  }

  try {
    return JSON.parse(readFileSync(usagePath, 'utf8'));
  } catch (error) {
    console.error('Failed to read episode LLM usage state:', error);
    return {
      total_requests: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cached_input_tokens: 0,
      total_cost_usd: 0,
      by_agent: {},
    };
  }
}

function writeUsageState(usagePath, state) {
  if (!usagePath) return;

  try {
    writeFileSync(usagePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (error) {
    console.error('Failed to write episode LLM usage state:', error);
  }
}

function computeCost(model, inputTokens, outputTokens, cachedInputTokens) {
  const rates = loadPricingTable()[model];
  if (!rates) return null;

  const billableInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const cost =
      (billableInputTokens / 1_000_000) * (rates.input_per_million ?? 0) +
      (cachedInputTokens / 1_000_000) * (rates.cached_input_per_million ?? 0) +
      (outputTokens / 1_000_000) * (rates.output_per_million ?? 0);
  return Number(cost.toFixed(6));
}

export function recordLLMUsage(
    agentName,
    {model, inputTokens = 0, outputTokens = 0, cachedInputTokens = 0} = {}) {
  const usagePath = getUsagePath();
  if (!usagePath) return;

  const state = readUsageState(usagePath);
  const cost = computeCost(model, inputTokens, outputTokens, cachedInputTokens);

  state.total_requests = (state.total_requests ?? 0) + 1;
  state.total_input_tokens = (state.total_input_tokens ?? 0) + inputTokens;
  state.total_output_tokens = (state.total_output_tokens ?? 0) + outputTokens;
  state.total_cached_input_tokens =
      (state.total_cached_input_tokens ?? 0) + cachedInputTokens;
  if (cost != null) {
    state.total_cost_usd = Number(((state.total_cost_usd ?? 0) + cost).toFixed(6));
  }

  const agentEntry = state.by_agent[agentName] ?? {
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cost_usd: 0,
  };
  agentEntry.requests += 1;
  agentEntry.input_tokens += inputTokens;
  agentEntry.output_tokens += outputTokens;
  agentEntry.cached_input_tokens += cachedInputTokens;
  if (cost != null) {
    agentEntry.cost_usd = Number((agentEntry.cost_usd + cost).toFixed(6));
  }
  state.by_agent[agentName] = agentEntry;

  writeUsageState(usagePath, state);
}
