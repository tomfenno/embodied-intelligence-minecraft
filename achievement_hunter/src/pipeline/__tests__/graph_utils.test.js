/**
 * Baseline tests for trim_graph_for_scsg and enrich_subgraph.
 * Imports from prompt_utils.js (current location).
 * After Phase 3c these will be moved to graph_utils.js and the import updated.
 */
import { describe, it, expect, vi } from 'vitest';

import { trim_graph_for_scsg, enrich_subgraph } from '../graph_utils.js';

// Shared fixture: a minimal but realistic PTD graph
const PTD_GRAPH = {
  objective: 'craft diamond sword',
  sinks: ['diamond_sword'],
  vertices: [
    { id: 'diamond_sword', qty: 1, item_type: 'craft', acquisition_dependency: null },
    { id: 'diamond',       qty: 2, item_type: 'mine',  acquisition_dependency: null },
    { id: 'stick',         qty: 1, item_type: 'craft', acquisition_dependency: 'planks' },
  ],
  edges: [
    { from: 'diamond', to: 'diamond_sword', qty: 2, consumed: true,  type: 'ingredient' },
    { from: 'stick',   to: 'diamond_sword', qty: 1, consumed: true,  type: 'ingredient' },
  ],
};

// ── trim_graph_for_scsg ─────────────────────────────────────────────────────

describe('trim_graph_for_scsg', () => {
  it('preserves objective and sinks', () => {
    const trimmed = trim_graph_for_scsg(PTD_GRAPH);
    expect(trimmed.objective).toBe('craft diamond sword');
    expect(trimmed.sinks).toEqual(['diamond_sword']);
  });

  it('keeps only id and qty on each vertex', () => {
    const trimmed = trim_graph_for_scsg(PTD_GRAPH);
    for (const v of trimmed.vertices) {
      expect(Object.keys(v)).toEqual(['id', 'qty']);
    }
  });

  it('keeps only from, to, qty, consumed on each edge', () => {
    const trimmed = trim_graph_for_scsg(PTD_GRAPH);
    for (const e of trimmed.edges) {
      expect(Object.keys(e)).toEqual(['from', 'to', 'qty', 'consumed']);
    }
  });

  it('strips item_type and acquisition_dependency from vertices', () => {
    const trimmed = trim_graph_for_scsg(PTD_GRAPH);
    for (const v of trimmed.vertices) {
      expect(v).not.toHaveProperty('item_type');
      expect(v).not.toHaveProperty('acquisition_dependency');
    }
  });

  it('strips type from edges', () => {
    const trimmed = trim_graph_for_scsg(PTD_GRAPH);
    for (const e of trimmed.edges) {
      expect(e).not.toHaveProperty('type');
    }
  });

  it('does not mutate the original graph', () => {
    const snapshot = JSON.stringify(PTD_GRAPH);
    trim_graph_for_scsg(PTD_GRAPH);
    expect(JSON.stringify(PTD_GRAPH)).toBe(snapshot);
  });
});

// ── enrich_subgraph ─────────────────────────────────────────────────────────

describe('enrich_subgraph', () => {
  // Subgraph where all three vertices are still present (nothing pruned)
  const FULL_SUBGRAPH = {
    objective: 'craft diamond sword',
    sinks: ['diamond_sword'],
    vertices: [
      { id: 'diamond_sword', qty: 1 },
      { id: 'diamond',       qty: 2 },
      { id: 'stick',         qty: 1 },
    ],
    edges: [
      { from: 'diamond', to: 'diamond_sword', qty: 2, consumed: true },
      { from: 'stick',   to: 'diamond_sword', qty: 1, consumed: true },
    ],
  };

  // Subgraph where 'stick' was pruned (already in inventory)
  const PRUNED_SUBGRAPH = {
    objective: 'craft diamond sword',
    sinks: ['diamond_sword'],
    vertices: [
      { id: 'diamond_sword', qty: 1 },
      { id: 'diamond',       qty: 2 },
      // 'stick' is absent — satisfied by current inventory
    ],
    edges: [
      { from: 'diamond', to: 'diamond_sword', qty: 2, consumed: true },
    ],
  };

  it('restores item_type to each vertex', () => {
    const enriched = enrich_subgraph(FULL_SUBGRAPH, PTD_GRAPH);
    const sword = enriched.vertices.find(v => v.id === 'diamond_sword');
    const diamond = enriched.vertices.find(v => v.id === 'diamond');
    expect(sword.item_type).toBe('craft');
    expect(diamond.item_type).toBe('mine');
  });

  it('restores acquisition_dependency to each vertex', () => {
    const enriched = enrich_subgraph(FULL_SUBGRAPH, PTD_GRAPH);
    const stick = enriched.vertices.find(v => v.id === 'stick');
    expect(stick.acquisition_dependency).toBe('planks');
  });

  it('restores type to each edge', () => {
    const enriched = enrich_subgraph(FULL_SUBGRAPH, PTD_GRAPH);
    for (const e of enriched.edges) {
      expect(e.type).toBe('ingredient');
    }
  });

  it('adds empty satisfied_inputs when no prerequisites were pruned', () => {
    const enriched = enrich_subgraph(FULL_SUBGRAPH, PTD_GRAPH);
    const sword = enriched.vertices.find(v => v.id === 'diamond_sword');
    expect(sword.satisfied_inputs).toEqual([]);
  });

  it('computes satisfied_inputs for a vertex whose prerequisite was pruned', () => {
    const enriched = enrich_subgraph(PRUNED_SUBGRAPH, PTD_GRAPH);
    const sword = enriched.vertices.find(v => v.id === 'diamond_sword');
    expect(sword.satisfied_inputs).toHaveLength(1);
    expect(sword.satisfied_inputs[0].from).toBe('stick');
    expect(sword.satisfied_inputs[0].type).toBe('ingredient');
  });

  it('does not include satisfied_inputs for vertices with no original edges pointing to them', () => {
    const enriched = enrich_subgraph(PRUNED_SUBGRAPH, PTD_GRAPH);
    const diamond = enriched.vertices.find(v => v.id === 'diamond');
    expect(diamond.satisfied_inputs).toEqual([]);
  });

  it('does not mutate the original subgraph or PTD graph', () => {
    const sub_snapshot = JSON.stringify(PRUNED_SUBGRAPH);
    const ptd_snapshot = JSON.stringify(PTD_GRAPH);
    enrich_subgraph(PRUNED_SUBGRAPH, PTD_GRAPH);
    expect(JSON.stringify(PRUNED_SUBGRAPH)).toBe(sub_snapshot);
    expect(JSON.stringify(PTD_GRAPH)).toBe(ptd_snapshot);
  });

  it('warns and returns the original vertex when its id is not in the PTD graph', () => {
    const warn_spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const subgraph_with_unknown = {
      objective: 'test',
      sinks: ['ghost_item'],
      vertices: [{ id: 'ghost_item', qty: 1 }],
      edges: [],
    };
    const enriched = enrich_subgraph(subgraph_with_unknown, PTD_GRAPH);
    expect(warn_spy).toHaveBeenCalledWith(expect.stringContaining('ghost_item'));
    // Original vertex is returned unchanged
    expect(enriched.vertices[0]).toEqual({ id: 'ghost_item', qty: 1 });
    warn_spy.mockRestore();
  });
});
