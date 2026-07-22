import { fileURLToPath } from 'url';
import path from 'path';
import { mkdirSync, writeFileSync, appendFileSync } from 'fs';

import { LlmClient } from '../../../achievement_hunter/src/pipeline/llm_client.js';
import { get_sgsg_state } from '../../../achievement_hunter/src/pipeline/agent_state.js';
import convoManager from '../../../src/agent/conversation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROLLOUTS_DIR = path.join(__dirname, '../../rollouts');

const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_ITERATIONS = 5;
const TEAMMATE_WAIT_TIMEOUT_MS = 30000;
const INTRO = "Hi, I'm coordinating this task. Before anyone starts, I'm gathering " +
    "what everyone has and needs. Please hold off on taking any actions until I " +
    "share the plan. ";

export async function runDisclosureLoop(agent, teammateChannel) {
  const llm = new LlmClient(DEFAULT_MODEL);
  const runDir = makeRunDir(agent.task.data.task_id);
  console.log(`[Disclosure Loop] starting for ${agent.name}, logging to ${runDir}`);

  const teammates = await waitForTeammates(agent);
  console.log(`[Disclosure Loop] teammates found: ${teammates.join(', ')}`);

  const doc = seedDocument(agent);
  writeDocument(runDir, doc);

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    const round = { iteration };
    let decision;
    try {
      const raw = await llm.send_prompt(buildAssessmentPrompt(doc, teammates));
      decision = parseDecision(raw, teammates);
      round.status = decision.status;
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
  writeDocument(runDir, doc);
  const totalQuestions = Object.values(doc.teammates).reduce((n, t) => n + t.qna.length, 0);
  console.log(`[Disclosure Loop] finished (${doc.status}) after ${totalQuestions} question(s). ` +
      `Document at ${path.join(runDir, 'world_state.json')}`);
  return doc;
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

function buildAssessmentPrompt(doc, teammates) {
  return `You are ${doc.self.name}, coordinating a Minecraft task with your teammate(s): ${teammates.join(', ')}.

Shared goal: ${doc.shared_goal}

Your own known state:
${JSON.stringify(doc.self, null, 2)}

What you've learned from teammates so far:
${JSON.stringify(doc.teammates, null, 2)}

Decide whether you now know enough about your team's combined inventory and constraints to start planning. If so, respond with exactly:
{"status": "complete"}

If not, respond with exactly one follow-up question for exactly one teammate you still need information from. Do not re-ask something already answered above:
{"status": "need_info", "next_query": {"target_agent": "<name>", "question": "<question>"}}

Respond with only the JSON object, no other text.`;
}

function parseDecision(raw, teammates) {
  if (!raw) throw new Error('LLM returned no response');
  const jsonText = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Could not parse LLM response as JSON: ${err.message}`);
  }

  if (parsed.status !== 'complete' && parsed.status !== 'need_info') {
    throw new Error(`Unexpected status "${parsed.status}"`);
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
