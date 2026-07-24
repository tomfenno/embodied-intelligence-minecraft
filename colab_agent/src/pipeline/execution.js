import path from 'path';
import { writeFileSync } from 'fs';

// Phase 3 makes zero LLM calls of its own — see
// colab_agent/docs/10-phase-3-execution.md §5. renderPTD is pure string
// formatting; startExecutionPhase composes andy's goal text and hands
// control to the stock self_prompter, the same loop jill already uses to
// pursue any task goal.

// Renders only the plan into prose — the objective statement itself comes
// from agent.self_prompter.prompt (already correct, stock-computed text),
// so this never needs to restate or re-derive the objective. selfName lets
// each vertex be tagged from the calling agent's own point of view without
// hard-coding agent names.
export function renderPTD(graph, summary, selfName) {
  const lines = [];
  if (summary) lines.push(summary);

  lines.push('', 'Vertices:');
  for (const v of graph.vertices) {
    const eligible = v.eligible_agents;
    const isAny = eligible === 'any';
    const mine = isAny || (Array.isArray(eligible) && eligible.includes(selfName));
    const tag = isAny ? 'anyone' : mine ? 'you' : (Array.isArray(eligible) ? eligible.join(', ') : eligible);
    lines.push(`- [${v.id}] ${v.description} (eligible: ${tag})`);
  }

  lines.push('', 'Order (left must finish before right can begin):');
  for (const e of graph.edges) {
    lines.push(`- ${e.from} before ${e.to}`);
  }

  lines.push('', `Done when: ${graph.sinks.join(', ')} ${graph.sinks.length > 1 ? 'are' : 'is'} complete.`);
  return lines.join('\n');
}

// Called once, when Phase 2 has produced a valid PTD. Hands the plan to the
// stock self_prompter instead of running any bespoke decision loop — see
// colab_agent/docs/10-phase-3-execution.md §1/§5.
export function startExecutionPhase(agent, graph, summary, runDir) {
  agent.executionStarted = true;

  const planText = renderPTD(graph, summary, agent.name);
  const baseGoal = agent.self_prompter.prompt || graph.objective || '';
  const goalText = `${baseGoal}\n\nHere is the plan the team agreed on:\n${planText}`;

  agent.memoryLog = agent.memoryLog || [];
  const memoryEntry = { phase: 'phase_3', status: 'started', summary };
  agent.memoryLog.push(memoryEntry);
  writeFileSync(path.join(runDir, 'memory.json'), JSON.stringify(agent.memoryLog, null, 2));
  console.log(`[Execution] phase 3 started: ${summary}`);

  agent.self_prompter.start(goalText);
}
