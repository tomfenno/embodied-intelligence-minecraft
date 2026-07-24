import { fileURLToPath } from 'url';
import path from 'path';
import { mkdirSync, writeFileSync, appendFileSync } from 'fs';

import { LlmClient } from '../../../achievement_hunter/src/pipeline/llm_client.js';
import { get_sgsg_state } from '../../../achievement_hunter/src/pipeline/agent_state.js';
import { extract_json } from '../../../achievement_hunter/src/pipeline/json_utils.js';
import convoManager from '../../../src/agent/conversation.js';
import { fill_assessment_prompt } from './prompt_utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROLLOUTS_DIR = path.join(__dirname, '../../rollouts');

const FALLBACK_MODEL = 'gpt-4o-mini'; // used only if the coordinator's own profile omits "model"
const MAX_ITERATIONS = 5;
const TEAMMATE_WAIT_TIMEOUT_MS = 30000;
const INVENTORY_WAIT_TIMEOUT_MS = 10000;
const INTRO = "Hi, I'm coordinating this task. Before anyone starts, I'm gathering " +
    "what everyone has and needs. Please hold off on taking any actions until I " +
    "share the plan. ";

export async function runDisclosureLoop(agent, teammateChannel) {
  // Reuses the coordinator's own Mindcraft profile "model" field (e.g.
  // colab_agent/profiles/andy.json) rather than a separate config file, so
  // each agent's profile independently controls its own model — the
  // responder's model already worked this way for her stock reactive path,
  // the coordinator's own reasoning just wasn't reading it until now.
  const llm = new LlmClient(agent.prompter.profile.model || FALLBACK_MODEL);
  const runDir = makeRunDir(agent.task.data.task_id);
  // Stashed on the agent (not just a local var) so the stock
  // ConversationManager can find it and write conversation.log into this
  // same rollout dir for the rest of the episode — see the AH-marked hook
  // in src/agent/conversation.js. Set as early as possible so no Phase 1
  // exchange is missed.
  agent.runDir = runDir;
  console.log(`[Disclosure Loop] starting for ${agent.name}, logging to ${runDir}`);

  const teammates = await waitForTeammates(agent);
  console.log(`[Disclosure Loop] teammates found: ${teammates.join(', ')}`);

  await waitForInventory(agent);
  const doc = seedDocument(agent);
  writeDocument(runDir, doc);

  let lastSummary = null;
  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    const round = { iteration };
    let decision;
    try {
      const raw = await llm.send_prompt(fill_assessment_prompt(doc, teammates));
      decision = parseDecision(raw, teammates);
      round.status = decision.status;
      round.summary = decision.summary;
      lastSummary = decision.summary;
    } catch (err) {
      console.error(`[Disclosure Loop] iteration ${iteration} assessment failed:`, err.message);
      round.error = err.message;
      appendRound(runDir, round);
      doc.status = 'error';
      break;
    }

    if (decision.status === 'complete') {
      console.log(`[Disclosure Loop] iteration ${iteration}: adequate, stopping`);
      appendRound(runDir, round);
      doc.status = 'complete';
      break;
    }

    const { target_agent, question } = decision.next_query;
    const questionText = iteration === 1 ? INTRO + question : question;
    round.target_agent = target_agent;
    round.question_sent = questionText;
    console.log(`[Disclosure Loop] iteration ${iteration}: asking ${target_agent}`);

    doc.teammates[target_agent] ??= { qna: [] };
    try {
      const answer = await teammateChannel.askTeammate(target_agent, questionText);
      round.answer = answer;
      doc.teammates[target_agent].qna.push({ question, answer });
    } catch (err) {
      console.warn(`[Disclosure Loop] query to ${target_agent} failed:`, err.message);
      round.error = err.message;
      doc.teammates[target_agent].qna.push({ question, answer: null, error: err.message });
    }

    appendRound(runDir, round);
    writeDocument(runDir, doc); // incremental save so a crash mid-loop doesn't lose progress
  }

  doc.status = doc.status ?? 'incomplete';
  for (const name of Object.keys(doc.teammates)) {
    teammateChannel.endConversation(name, "Thanks, that's everything I need for now — standing by.");
  }
  writeDocument(runDir, doc);

  // Narrative memory, kept deliberately separate from world_state.json: a
  // short per-phase note for later phases to orient against, not a source of
  // truth for facts (that stays world_state.json's job). The summary comes
  // free from the assessment call that was already deciding the loop was
  // done — no dedicated summarization call, same trick as
  // achievement_hunter's failure_replanner "diagnosis" field.
  agent.memoryLog = agent.memoryLog || [];
  const memoryEntry = {
    phase: 'phase_1',
    status: doc.status,
    summary: lastSummary ?? `Phase 1 ended in ${doc.status} before any assessment completed.`,
  };
  agent.memoryLog.push(memoryEntry);
  writeFileSync(path.join(runDir, 'memory.json'), JSON.stringify(agent.memoryLog, null, 2));
  console.log(`[Disclosure Loop] memory recorded: ${memoryEntry.summary}`);

  const totalQuestions = Object.values(doc.teammates).reduce((n, t) => n + t.qna.length, 0);
  console.log(`[Disclosure Loop] finished (${doc.status}) after ${totalQuestions} question(s). ` +
      `Document at ${path.join(runDir, 'world_state.json')}`);
  return { doc, runDir };
}

function appendRound(runDir, round) {
  appendFileSync(path.join(runDir, 'iterations.jsonl'), JSON.stringify(round) + '\n');
}

function writeDocument(runDir, doc) {
  writeFileSync(path.join(runDir, 'world_state.json'), JSON.stringify(doc, null, 2));
}

// count_id 0 is spawned first and starts polling for presence almost
// immediately, but the task's own conversation seed (and the teammate's
// login) can lag behind by a second or more — this waits for the roster to
// actually match agent_count before the loop starts asking anyone anything.
async function waitForTeammates(agent, timeoutMs = TEAMMATE_WAIT_TIMEOUT_MS) {
  const expected = (agent.task.data.agent_count || 2) - 1;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const teammates = convoManager.getInGameAgents().filter(name => name !== agent.name);
    if (teammates.length >= expected) return teammates;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const found = convoManager.getInGameAgents().filter(name => name !== agent.name);
  throw new Error(`Timed out waiting for teammates (expected ${expected}, found [${found.join(', ')}])`);
}

// /give is fire-and-forget from the bot's side (there's no confirmation the
// server has processed it and mineflayer's bot.inventory reflects it yet), so
// this waits for the specific quantities the task JSON promised rather than
// guessing at a delay or a generic "non-empty" check — an agent whose slice
// of initial_inventory is legitimately empty returns immediately.
async function waitForInventory(agent, timeoutMs = INVENTORY_WAIT_TIMEOUT_MS) {
  const expected = agent.task.data.initial_inventory?.[String(agent.count_id)] || {};
  const expectedEntries = Object.entries(expected);
  if (expectedEntries.length === 0) return;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const inventory = get_sgsg_state(agent).inventory;
    const counts = inventory === 'Nothing' ? {} : inventory;
    if (expectedEntries.every(([item, count]) => (counts[item] || 0) >= count)) {
      console.log('[Disclosure Loop] initial inventory confirmed');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  console.warn(`[Disclosure Loop] initial_inventory grant not confirmed within ${timeoutMs}ms; seeding self-state anyway`);
}

function seedDocument(agent) {
  const goal = agent.task.data.goal;
  return {
    task_id: agent.task.data.task_id,
    shared_goal: typeof goal === 'string' ? goal : goal['0'],
    self: {
      name: agent.name,
      ...get_sgsg_state(agent),
      blocked_actions: agent.task.blocked_actions,
    },
    teammates: {},
    status: null,
  };
}

function parseDecision(raw, teammates) {
  if (!raw) throw new Error('LLM returned no response');
  const parsed = extract_json(raw);
  if (!parsed) {
    throw new Error('Could not extract a JSON object from the LLM response');
  }

  if (parsed.status !== 'complete' && parsed.status !== 'need_info') {
    throw new Error(`Unexpected status "${parsed.status}"`);
  }
  if (!parsed.summary) {
    throw new Error('Response missing "summary" field');
  }
  if (parsed.status === 'need_info') {
    if (!parsed.next_query?.question) {
      throw new Error('need_info response missing next_query.question');
    }
    if (!teammates.includes(parsed.next_query.target_agent)) {
      parsed.next_query.target_agent = teammates[0];
    }
  }
  return parsed;
}

function makeRunDir(task_id) {
  const safeTaskId = (task_id || 'unknown_task').replace(/[^a-zA-Z0-9_-]/g, '_');
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(ROLLOUTS_DIR, safeTaskId, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}
