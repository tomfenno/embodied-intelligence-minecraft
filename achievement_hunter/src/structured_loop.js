import {
  extract_json,
  fill_ptd_prompt,
  fill_scsg_prompt,
  fill_next_task_selector_prompt,
  fill_action_mediator_prompt,
  enrich_subgraph,
  trim_graph_for_scsg,
  get_state,
  get_inventory_state,
} from './prompt_utils.js';
import { createRolloutLogger } from './rollout_logger.js';

const MAX_INNER_RETRIES = 5;

/**
 * Runs the Structured Prompting Loop for a primary task T.
 *
 * Flow:
 *   1. PTD  — build a full prerequisite dependency graph for T
 *   2. SCSG — prune the graph to what is still needed given current inventory
 *   3. NTS  — pick the next immediate task from the pruned graph
 *   4. AM   — convert that task into a bot command and execute it
 *   Repeat from (2) until the SCSG signals all sinks are satisfied (r=2).
 *
 * @param {object} model  - Model instance with sendRequest(turns, systemMessage).
 * @param {object} agent  - The Mindcraft agent instance.
 * @param {string} T      - The primary task objective (e.g. "craft a diamond sword").
 */
export async function structuredLoop(model, agent, T) {
  const log = createRolloutLogger(T);

  // ── Phase 1: Build the Prerequisite Task DAG (PTD) ───────────────────────
  console.log('[SPL] Building PTD for:', T);

  const ptd_response = await model.sendRequest([], fill_ptd_prompt(T));
  const G = extract_json(ptd_response);
  log.ptd(ptd_response, G);

  if (!G) {
    console.error('[SPL] Failed to extract PTD graph from LLM response.');
    log.complete('PTD extraction failed');
    return;
  }
  console.log('[SPL] PTD built.');

  // ── Phase 2: Outer Loop ───────────────────────────────────────────────────
  while (true) {
    // SCSG only needs inventory, not the full state
    const { inventory } = get_inventory_state(agent);

    // Build and send the SCSG prompt
    const scsg_response = await model.sendRequest(
      [],
      fill_scsg_prompt(trim_graph_for_scsg(G), { inventory })
    );
    const scsg_result = extract_json(scsg_response);
    log.scsg(scsg_response, scsg_result);

    if (!scsg_result) {
      console.error('[SPL] Failed to extract SCSG result from LLM response, retrying...');
      continue;
    }

    // r=2 means all original sinks are already satisfied — task is done
    if (scsg_result.r === 2) {
      console.log('[SPL] Task complete — all sinks satisfied.');
      log.complete('all sinks satisfied');
      return;
    }

    // r=1: inventory is "Nothing", final contains the full original graph
    // r=0: normal pruned subgraph
    // Both cases: the subgraph is at scsg_result.final
    const subgraph = {
      objective: G.objective,
      sinks: scsg_result.r === 1 ? G.sinks : scsg_result.s,
      ...scsg_result.final
    };

    if (!subgraph.vertices || subgraph.vertices.length === 0) {
      console.log('[SPL] Task complete — subgraph is empty.');
      log.complete('subgraph empty');
      return;
    }

    // Enrich the subgraph before passing to NTS
    const enriched = enrich_subgraph(subgraph, G);

    // ── Phase 3: NTS — select next immediate task ─────────────────────────
    const s = get_state(agent);
    const nts_response = await model.sendRequest([], fill_next_task_selector_prompt(enriched, s));
    const task = extract_json(nts_response);
    log.nts(nts_response, task);

    if (!task) {
      console.error('[SPL] Failed to extract task from NTS response.');
      continue;
    }
    console.log('[SPL] Next task:', JSON.stringify(task));

    // ── Phase 4: Inner Loop — execute the task via Action Mediator ─────────
    let status = 'fail';

    for (let attempt = 0; attempt < MAX_INNER_RETRIES; attempt++) {
      const s_inner = get_state(agent);

      // Build and send the Action Mediator prompt
      const action = await model.sendRequest([], fill_action_mediator_prompt(task, s_inner));
      log.am(attempt + 1, action);
      console.log(`[SPL] Action (attempt ${attempt + 1}/${MAX_INNER_RETRIES}):`, action);

      // AM signals completion via {"status":"TASK_COMPLETE"} when inventory already satisfies the task
      const completion_signal = extract_json(action);
      if (completion_signal?.status === 'TASK_COMPLETE') {
        console.log('[SPL] AM reports task already complete:', task.target_item);
        status = 'success';
        break;
      }

      // Execute the action through the agent's existing command/action pipeline
      await agent.handleMessage('system', action);

      // Re-check via AM on next iteration — it will emit TASK_COMPLETE if done
    }

    if (status !== 'success') {
      console.log('[SPL] Task failed after max retries, re-evaluating state...');
      // Outer loop continues: re-query inventory and re-run SCSG to pick a new sub-task
    }
  }

}
