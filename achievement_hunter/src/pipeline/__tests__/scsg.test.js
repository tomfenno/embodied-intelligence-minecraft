import { describe, it, expect } from 'vitest';
import {
  compute_scsg,
  get_sinks,
  state_satisfied_vertices,
  update_quantities_and_prune,
} from '../scsg.js';

// ── Shared fixtures ───────────────────────────────────────────────────────────

// oak_log → oak_planks → stick → diamond_sword (diamond is also needed)
const DIAMOND_SWORD_GRAPH = {
  objective: 'craft diamond sword',
  sinks: ['diamond_sword'],
  vertices: [
    { id: 'diamond_sword', qty: 1, item_type: 'craft' },
    { id: 'diamond',       qty: 2, item_type: 'resource' },
    { id: 'stick',         qty: 1, item_type: 'craft' },
    { id: 'oak_planks',    qty: 2, item_type: 'craft' },
    { id: 'oak_log',       qty: 1, item_type: 'resource' },
  ],
  edges: [
    { from: 'diamond',    to: 'diamond_sword', qty: 2, consumed: true,  type: 'crafting_input' },
    { from: 'stick',      to: 'diamond_sword', qty: 1, consumed: true,  type: 'crafting_input' },
    { from: 'oak_planks', to: 'stick',         qty: 2, consumed: true,  type: 'crafting_input' },
    { from: 'oak_log',    to: 'oak_planks',    qty: 1, consumed: true,  type: 'crafting_input' },
  ],
};

// Graph with an any_log abstract node
const ANY_LOG_GRAPH = {
  objective: 'craft oak planks',
  sinks: ['oak_planks'],
  vertices: [
    { id: 'oak_planks', qty: 4, item_type: 'craft' },
    { id: 'any_log',    qty: 1, item_type: 'resource' },
  ],
  edges: [
    { from: 'any_log', to: 'oak_planks', qty: 1, consumed: true, type: 'crafting_input' },
  ],
};

// ── get_sinks ─────────────────────────────────────────────────────────────────

describe('get_sinks', () => {
  it('returns vertices with no outgoing edges', () => {
    const sinks = get_sinks(DIAMOND_SWORD_GRAPH);
    expect(sinks.map(v => v.id)).toEqual(['diamond_sword']);
  });

  it('returns all vertices for a graph with no edges', () => {
    const G = { vertices: [{ id: 'a', qty: 1 }, { id: 'b', qty: 1 }], edges: [] };
    const sinks = get_sinks(G);
    expect(sinks.map(v => v.id)).toEqual(expect.arrayContaining(['a', 'b']));
    expect(sinks).toHaveLength(2);
  });

  it('returns empty array for an empty vertex list', () => {
    const G = { vertices: [], edges: [] };
    expect(get_sinks(G)).toEqual([]);
  });
});

// ── state_satisfied_vertices ──────────────────────────────────────────────────

describe('state_satisfied_vertices', () => {
  it('returns vertex when inventory count meets qty', () => {
    const G = { vertices: [{ id: 'diamond', qty: 2 }] };
    const result = state_satisfied_vertices(G, { diamond: 2 });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('diamond');
  });

  it('rejects vertex when inventory count is below qty', () => {
    const G = { vertices: [{ id: 'diamond', qty: 2 }] };
    const result = state_satisfied_vertices(G, { diamond: 1 });
    expect(result).toHaveLength(0);
  });

  it('rejects vertex absent from inventory', () => {
    const G = { vertices: [{ id: 'diamond', qty: 1 }] };
    const result = state_satisfied_vertices(G, {});
    expect(result).toHaveLength(0);
  });

  it('satisfies any_log by summing concrete log variants', () => {
    const G = { vertices: [{ id: 'any_log', qty: 3 }] };
    const inventory = { oak_log: 1, spruce_log: 1, birch_log: 1 };
    const result = state_satisfied_vertices(G, inventory);
    expect(result).toHaveLength(1);
  });

  it('rejects any_log when total is below qty', () => {
    const G = { vertices: [{ id: 'any_log', qty: 3 }] };
    const inventory = { oak_log: 2 };
    const result = state_satisfied_vertices(G, inventory);
    expect(result).toHaveLength(0);
  });

  it('treats unknown any_* classes as unsatisfied', () => {
    const G = { vertices: [{ id: 'any_unknown_class', qty: 1 }] };
    const result = state_satisfied_vertices(G, { some_item: 99 });
    expect(result).toHaveLength(0);
  });
});

// ── update_quantities_and_prune ───────────────────────────────────────────────

describe('update_quantities_and_prune', () => {
  it('returns the same graph when V_rm is empty', () => {
    const result = update_quantities_and_prune([], DIAMOND_SWORD_GRAPH);
    expect(result.vertices).toHaveLength(DIAMOND_SWORD_GRAPH.vertices.length);
    expect(result.edges).toHaveLength(DIAMOND_SWORD_GRAPH.edges.length);
  });

  it('removes the specified vertex', () => {
    const v_rm = DIAMOND_SWORD_GRAPH.vertices.filter(v => v.id === 'oak_log');
    const result = update_quantities_and_prune(v_rm, DIAMOND_SWORD_GRAPH);
    expect(result.vertices.find(v => v.id === 'oak_log')).toBeUndefined();
  });

  it('removes edges incident to the pruned vertex', () => {
    const v_rm = DIAMOND_SWORD_GRAPH.vertices.filter(v => v.id === 'oak_log');
    const result = update_quantities_and_prune(v_rm, DIAMOND_SWORD_GRAPH);
    expect(result.edges.some(e => e.from === 'oak_log' || e.to === 'oak_log')).toBe(false);
  });

  it('decrements upstream prerequisite qty for consumed edges', () => {
    // Removing oak_planks (the dependent) triggers decrement of its prerequisite oak_log.
    // Edge: oak_log→oak_planks, qty=1, consumed=true → dec[oak_log] += 1 → oak_log.qty = 1-1 = 0.
    // (Removing oak_log would not decrement anything — it has no predecessors.)
    const v_rm = DIAMOND_SWORD_GRAPH.vertices.filter(v => v.id === 'oak_planks');
    const result = update_quantities_and_prune(v_rm, DIAMOND_SWORD_GRAPH);
    const log = result.vertices.find(v => v.id === 'oak_log');
    expect(log.qty).toBe(0);
  });

  it('does not decrement upstream qty for non-consumed edges', () => {
    const G = {
      vertices: [{ id: 'a', qty: 5 }, { id: 'b', qty: 2 }],
      edges: [{ from: 'a', to: 'b', qty: 2, consumed: false }],
    };
    const result = update_quantities_and_prune([G.vertices[1]], G);
    const a = result.vertices.find(v => v.id === 'a');
    expect(a.qty).toBe(5); // unchanged
  });

  it('does not mutate the original graph', () => {
    const snapshot = JSON.stringify(DIAMOND_SWORD_GRAPH);
    const v_rm = DIAMOND_SWORD_GRAPH.vertices.filter(v => v.id === 'oak_log');
    update_quantities_and_prune(v_rm, DIAMOND_SWORD_GRAPH);
    expect(JSON.stringify(DIAMOND_SWORD_GRAPH)).toBe(snapshot);
  });
});

// Minimal wooden-pickaxe graph used by the pre-pass partial-satisfaction tests.
// any_log → any_plank → wooden_pickaxe; stick → wooden_pickaxe
const WOODEN_PICKAXE_GRAPH = {
  objective: 'craft wooden pickaxe',
  sinks: ['wooden_pickaxe'],
  vertices: [
    { id: 'wooden_pickaxe', qty: 1, item_type: 'tool' },
    { id: 'any_plank',      qty: 3, item_type: 'craft' },
    { id: 'stick',          qty: 2, item_type: 'craft' },
    { id: 'any_log',        qty: 1, item_type: 'resource' },
  ],
  edges: [
    { from: 'any_plank', to: 'wooden_pickaxe', qty: 3, consumed: true,  type: 'crafting_input' },
    { from: 'stick',     to: 'wooden_pickaxe', qty: 2, consumed: true,  type: 'crafting_input' },
    { from: 'any_log',   to: 'any_plank',      qty: 1, consumed: true,  type: 'crafting_input' },
  ],
};

// Graph used to test upstream scaling: any_log(3) → any_plank(12) → output(1).
// With 8 planks already held the pre-pass should scale the log requirement from
// 3 down to 1 (need 4 more planks = 1 log × 4 planks/log).
const UPSTREAM_SCALING_GRAPH = {
  objective: 'gather planks',
  sinks: ['output'],
  vertices: [
    { id: 'output',    qty: 1,  item_type: 'craft' },
    { id: 'any_plank', qty: 12, item_type: 'craft' },
    { id: 'any_log',   qty: 3,  item_type: 'resource' },
  ],
  edges: [
    { from: 'any_plank', to: 'output',    qty: 12, consumed: true, type: 'crafting_input' },
    { from: 'any_log',   to: 'any_plank', qty: 3,  consumed: true, type: 'crafting_input' },
  ],
};

// ── compute_scsg — partial inventory / pre-pass ───────────────────────────────

describe('compute_scsg — partial inventory pre-pass', () => {
  // ── Regression: the double-counting bug ──────────────────────────────────────
  //
  // Bug: the pre-pass reduced any_plank.qty from 3 → 1 to signal "need 1 more".
  // The fixed-point then checked inventory_count(spruce_planks=2) >= qty(1) → true
  // and falsely pruned any_plank, making wooden_pickaxe appear craftable without
  // the required 3 planks.
  //
  // Trigger condition: have > (original_qty - have), i.e. have > qty/2.
  // Here: have=2, qty=3 → 2 > 1 → bug triggers.

  it('does not prune any_plank when have=2 of 3 needed (regression: pre-pass double-counting)', () => {
    const result = compute_scsg(WOODEN_PICKAXE_GRAPH, { spruce_planks: 2, stick: 13 });
    expect(result.r).toBe(0);
    const ids = result.final.vertices.map(v => v.id);
    expect(ids).toContain('any_plank');
    expect(ids).toContain('wooden_pickaxe');
  });

  it('does not expose wooden_pickaxe as a source candidate when any_plank is unsatisfied', () => {
    // wooden_pickaxe still has any_plank as an unmet input, so it must not
    // appear as a leaf/source in the pruned subgraph.
    const result = compute_scsg(WOODEN_PICKAXE_GRAPH, { spruce_planks: 2, stick: 13 });
    const sources = result.final.vertices.filter(v => {
      const has_incoming = result.final.edges.some(e => e.to === v.id);
      return !has_incoming;
    });
    const source_ids = sources.map(v => v.id);
    expect(source_ids).not.toContain('wooden_pickaxe');
  });

  // ── have < qty/2 (bug would not have triggered, but should still be correct) ─

  it('does not prune any_plank when have=1 of 3 needed', () => {
    const result = compute_scsg(WOODEN_PICKAXE_GRAPH, { spruce_planks: 1, stick: 13 });
    expect(result.r).toBe(0);
    expect(result.final.vertices.map(v => v.id)).toContain('any_plank');
  });

  // ── Fully satisfied: vertex must be pruned ────────────────────────────────────

  it('prunes any_plank when inventory exactly meets the required qty', () => {
    // have=3, qty=3 → satisfied → pruned. any_log also disappears (no longer
    // needed). Only wooden_pickaxe remains — all prerequisites are met but the
    // item still needs to be crafted, so r=0 not r=2.
    const result = compute_scsg(WOODEN_PICKAXE_GRAPH, { spruce_planks: 3, stick: 13 });
    expect(result.r).toBe(0);
    const ids = result.final.vertices.map(v => v.id);
    expect(ids).not.toContain('any_plank');
    expect(ids).not.toContain('any_log');
    expect(ids).toContain('wooden_pickaxe');
  });

  it('prunes any_plank when inventory exceeds the required qty', () => {
    const result = compute_scsg(WOODEN_PICKAXE_GRAPH, { spruce_planks: 10, stick: 13 });
    expect(result.r).toBe(0);
    const ids = result.final.vertices.map(v => v.id);
    expect(ids).not.toContain('any_plank');
    expect(ids).toContain('wooden_pickaxe');
  });

  it('returns r=2 when the sink item itself is already in inventory', () => {
    const result = compute_scsg(WOODEN_PICKAXE_GRAPH, { wooden_pickaxe: 1 });
    expect(result.r).toBe(2);
  });

  // ── Concrete (non-abstract) items exhibit the same behaviour ─────────────────

  it('does not prune oak_planks (concrete) when have=2 of 3 needed', () => {
    const G = {
      objective: 'craft wooden pickaxe',
      sinks: ['wooden_pickaxe'],
      vertices: [
        { id: 'wooden_pickaxe', qty: 1 },
        { id: 'oak_planks',     qty: 3 },
        { id: 'stick',          qty: 2 },
      ],
      edges: [
        { from: 'oak_planks', to: 'wooden_pickaxe', qty: 3, consumed: true },
        { from: 'stick',      to: 'wooden_pickaxe', qty: 2, consumed: true },
      ],
    };
    const result = compute_scsg(G, { oak_planks: 2, stick: 13 });
    expect(result.r).toBe(0);
    expect(result.final.vertices.map(v => v.id)).toContain('oak_planks');
  });

  // ── Pre-pass upstream scaling ─────────────────────────────────────────────────
  //
  // With 8 of 12 planks already held (need 4 more = 1 log), the pre-pass should
  // scale the any_log requirement from 3 down to 1. Holding 1 log in inventory
  // should then be enough to satisfy any_log and prune it, leaving any_plank as
  // the next candidate rather than any_log.

  it('scales upstream any_log requirement down when planks are partially held', () => {
    // have spruce_planks=8 (need 4 more), spruce_log=1.
    // After pre-pass, any_log.qty should be 1 → satisfied by spruce_log → pruned.
    const result = compute_scsg(UPSTREAM_SCALING_GRAPH, { spruce_planks: 8, spruce_log: 1 });
    expect(result.r).toBe(0);
    const ids = result.final.vertices.map(v => v.id);
    expect(ids).not.toContain('any_log');   // scaled down + satisfied → pruned
    expect(ids).toContain('any_plank');     // still needs 4 more planks
    expect(ids).toContain('output');
  });

  it('keeps any_log when holding partial planks but no logs', () => {
    const result = compute_scsg(UPSTREAM_SCALING_GRAPH, { spruce_planks: 8 });
    expect(result.r).toBe(0);
    const ids = result.final.vertices.map(v => v.id);
    expect(ids).toContain('any_log');
    expect(ids).toContain('any_plank');
  });

  it('does not mutate the original graph during partial-inventory computation', () => {
    const snapshot = JSON.stringify(WOODEN_PICKAXE_GRAPH);
    compute_scsg(WOODEN_PICKAXE_GRAPH, { spruce_planks: 2, stick: 13 });
    expect(JSON.stringify(WOODEN_PICKAXE_GRAPH)).toBe(snapshot);
  });
});

// ── compute_scsg ──────────────────────────────────────────────────────────────

describe('compute_scsg', () => {
  it('returns r=1 when inventory is the string "Nothing"', () => {
    const result = compute_scsg(DIAMOND_SWORD_GRAPH, 'Nothing');
    expect(result.r).toBe(1);
    expect(result.why).toBe('S.inventory==Nothing');
    expect(result.final.vertices).toBe(DIAMOND_SWORD_GRAPH.vertices);
    expect(result.final.edges).toBe(DIAMOND_SWORD_GRAPH.edges);
  });

  it('returns r=2 when all sinks are already satisfied', () => {
    const result = compute_scsg(DIAMOND_SWORD_GRAPH, { diamond_sword: 1 });
    expect(result.r).toBe(2);
    expect(result.why).toBe('all original sinks satisfied');
    expect(result.final.vertices).toEqual([]);
    expect(result.final.edges).toEqual([]);
  });

  it('returns r=0 with original sink ids in s when work remains', () => {
    const result = compute_scsg(DIAMOND_SWORD_GRAPH, {});
    expect(result.r).toBe(0);
    expect(result.s).toEqual(['diamond_sword']);
  });

  it('prunes vertices already in inventory', () => {
    // Player has sticks but not diamonds or diamond_sword
    const result = compute_scsg(DIAMOND_SWORD_GRAPH, { stick: 4, oak_planks: 8, oak_log: 4 });
    expect(result.r).toBe(0);
    const ids = result.final.vertices.map(v => v.id);
    // oak_log, oak_planks, and stick should all be pruned (satisfied)
    expect(ids).not.toContain('oak_log');
    expect(ids).not.toContain('oak_planks');
    expect(ids).not.toContain('stick');
    // diamond and diamond_sword remain
    expect(ids).toContain('diamond');
    expect(ids).toContain('diamond_sword');
  });

  it('prunes edges whose endpoints were removed', () => {
    const result = compute_scsg(DIAMOND_SWORD_GRAPH, { stick: 4, oak_planks: 8, oak_log: 4 });
    // No edge should reference a pruned vertex
    const remaining_ids = new Set(result.final.vertices.map(v => v.id));
    for (const e of result.final.edges) {
      expect(remaining_ids.has(e.from)).toBe(true);
      expect(remaining_ids.has(e.to)).toBe(true);
    }
  });

  it('returns an empty subgraph when all nodes are satisfied', () => {
    const inventory = { diamond_sword: 1, diamond: 2, stick: 4, oak_planks: 8, oak_log: 4 };
    const result = compute_scsg(DIAMOND_SWORD_GRAPH, inventory);
    expect(result.r).toBe(2);
    expect(result.final.vertices).toEqual([]);
  });

  it('handles any_log in graph — pruned when inventory has enough concrete logs', () => {
    // any_log(qty=1) is satisfied by spruce_log.
    // It gets pruned, removing the any_log→oak_planks edge.
    // oak_planks is the original sink — V_disc won't include it — it stays.
    // oak_planks qty remains 4 (no upstream decrement: edges TO any_log are none).
    // r=0 with just oak_planks remaining.
    const result = compute_scsg(ANY_LOG_GRAPH, { spruce_log: 1 });
    expect(result.r).toBe(0);
    expect(result.final.vertices.map(v => v.id)).toEqual(['oak_planks']);
    expect(result.final.edges).toHaveLength(0);
  });

  it('returns r=2 when the only sink is directly satisfied', () => {
    const result = compute_scsg(ANY_LOG_GRAPH, { oak_planks: 4 });
    expect(result.r).toBe(2);
  });

  it('does not mutate the original PTD graph', () => {
    const snapshot = JSON.stringify(DIAMOND_SWORD_GRAPH);
    compute_scsg(DIAMOND_SWORD_GRAPH, { stick: 4 });
    expect(JSON.stringify(DIAMOND_SWORD_GRAPH)).toBe(snapshot);
  });

  it('handles an empty inventory object (not "Nothing")', () => {
    const result = compute_scsg(DIAMOND_SWORD_GRAPH, {});
    expect(result.r).toBe(0);
    // Nothing pruned — full graph returned
    expect(result.final.vertices).toHaveLength(DIAMOND_SWORD_GRAPH.vertices.length);
    expect(result.final.edges).toHaveLength(DIAMOND_SWORD_GRAPH.edges.length);
  });

  it('only prunes satisfied raw material — does not cascade via source exposure', () => {
    // oak_log is pruned (satisfied). oak_planks still has an outgoing edge to stick,
    // so it does NOT become a new sink. No V_disc cascade occurs.
    // oak_planks, stick, diamond, diamond_sword all remain.
    const result = compute_scsg(DIAMOND_SWORD_GRAPH, { oak_log: 1 });
    const ids = result.final.vertices.map(v => v.id);
    expect(ids).not.toContain('oak_log');
    expect(ids).toContain('oak_planks');
    expect(ids).toContain('stick');
    expect(ids).toContain('diamond');
    expect(ids).toContain('diamond_sword');
  });

  it('cascades via V_disc: satisfying stick removes its outgoing edge, making oak_planks a new sink', () => {
    // stick(1) is satisfied → pruned (V_sat).
    // Pruning stick removes oak_planks→stick and stick→diamond_sword edges.
    // oak_planks now has no outgoing edges → it's a new sink → pruned as V_disc.
    // Pruning oak_planks decrements oak_log.qty to 0.
    // In the next iteration, oak_log(qty=0) passes the inventory check (0>=0) → pruned as V_sat.
    // Final: only diamond and diamond_sword remain.
    const result = compute_scsg(DIAMOND_SWORD_GRAPH, { stick: 1 });
    const ids = result.final.vertices.map(v => v.id);
    expect(ids).not.toContain('stick');
    expect(ids).not.toContain('oak_planks');
    expect(ids).not.toContain('oak_log');
    expect(ids).toContain('diamond');
    expect(ids).toContain('diamond_sword');
  });
});
