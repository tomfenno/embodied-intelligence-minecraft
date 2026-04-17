/**
 * Baseline tests for trim_graph_for_scsg and enrich_subgraph.
 * Imports from prompt_utils.js (current location).
 * After Phase 3c these will be moved to graph_utils.js and the import updated.
 */
import {describe, expect, it, vi} from 'vitest';

import {enrich_subgraph, enrich_subgraph_sources, trim_graph_for_scsg} from '../graph_utils.js';

// Shared fixture: a minimal but realistic PTD graph
const PTD_GRAPH = {
  objective: 'craft diamond sword',
  sinks: ['diamond_sword'],
  vertices: [
    {
      id: 'diamond_sword',
      qty: 1,
      item_type: 'craft',
      acquisition_dependency: null
    },
    {id: 'diamond', qty: 2, item_type: 'mine', acquisition_dependency: null},
    {id: 'stick', qty: 1, item_type: 'craft', acquisition_dependency: 'planks'},
  ],
  edges: [
    {
      from: 'diamond',
      to: 'diamond_sword',
      qty: 2,
      consumed: true,
      type: 'ingredient'
    },
    {
      from: 'stick',
      to: 'diamond_sword',
      qty: 1,
      consumed: true,
      type: 'ingredient'
    },
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
      {id: 'diamond_sword', qty: 1},
      {id: 'diamond', qty: 2},
      {id: 'stick', qty: 1},
    ],
    edges: [
      {from: 'diamond', to: 'diamond_sword', qty: 2, consumed: true},
      {from: 'stick', to: 'diamond_sword', qty: 1, consumed: true},
    ],
  };

  // Subgraph where 'stick' was pruned (already in inventory)
  const PRUNED_SUBGRAPH = {
    objective: 'craft diamond sword',
    sinks: ['diamond_sword'],
    vertices: [
      {id: 'diamond_sword', qty: 1},
      {id: 'diamond', qty: 2},
      // 'stick' is absent — satisfied by current inventory
    ],
    edges: [
      {from: 'diamond', to: 'diamond_sword', qty: 2, consumed: true},
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

  it('computes satisfied_inputs for a vertex whose prerequisite was pruned',
     () => {
       const enriched = enrich_subgraph(PRUNED_SUBGRAPH, PTD_GRAPH);
       const sword = enriched.vertices.find(v => v.id === 'diamond_sword');
       expect(sword.satisfied_inputs).toHaveLength(1);
       expect(sword.satisfied_inputs[0].from).toBe('stick');
       expect(sword.satisfied_inputs[0].type).toBe('ingredient');
     });

  it('does not include satisfied_inputs for vertices with no original edges pointing to them',
     () => {
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

  it('warns and returns the original vertex when its id is not in the PTD graph',
     () => {
       const warn_spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
       const subgraph_with_unknown = {
         objective: 'test',
         sinks: ['ghost_item'],
         vertices: [{id: 'ghost_item', qty: 1}],
         edges: [],
       };
       const enriched = enrich_subgraph(subgraph_with_unknown, PTD_GRAPH);
       expect(warn_spy).toHaveBeenCalledWith(
           expect.stringContaining('ghost_item'));
       // Original vertex is returned unchanged
       expect(enriched.vertices[0]).toEqual({id: 'ghost_item', qty: 1});
       warn_spy.mockRestore();
     });
});

// ── enrich_subgraph_sources ─────────────────────────────────────────────────
//
// Fixtures are taken directly from the "Make a wooden pickaxe" rollout
// (2026-04-12T03-42-17-820Z). The PTD is the full prerequisite graph;
// the two SCSG snapshots represent (a) nothing pruned yet and (b) any_log
// already satisfied by the bot's inventory.

const WOODEN_PICKAXE_PTD = {
  objective: 'Make a wooden pickaxe',
  sinks: ['wooden_pickaxe'],
  vertices: [
    {
      id: 'wooden_pickaxe',
      qty: 1,
      item_type: 'tool',
      acquisition_dependency: 'none'
    },
    {
      id: 'crafting_table',
      qty: 1,
      item_type: 'workstation',
      acquisition_dependency: 'none'
    },
    {id: 'stick', qty: 4, item_type: 'item', acquisition_dependency: 'none'},
    {
      id: 'any_plank',
      qty: 12,
      item_type: 'item',
      acquisition_dependency: 'none'
    },
    {
      id: 'any_log',
      qty: 3,
      item_type: 'resource',
      acquisition_dependency: 'none'
    },
  ],
  edges: [
    {
      from: 'any_log',
      to: 'any_plank',
      type: 'crafting_input',
      qty: 3,
      consumed: true
    },
    {
      from: 'any_plank',
      to: 'crafting_table',
      type: 'crafting_input',
      qty: 4,
      consumed: true
    },
    {
      from: 'any_plank',
      to: 'stick',
      type: 'crafting_input',
      qty: 2,
      consumed: true
    },
    {
      from: 'any_plank',
      to: 'wooden_pickaxe',
      type: 'crafting_input',
      qty: 3,
      consumed: true
    },
    {
      from: 'stick',
      to: 'wooden_pickaxe',
      type: 'crafting_input',
      qty: 2,
      consumed: true
    },
    {
      from: 'crafting_table',
      to: 'wooden_pickaxe',
      type: 'workstation_dependency',
      qty: 1,
      consumed: false
    },
  ],
};

// SCSG r=1 "Nothing" — full graph, no vertices pruned.
// Source node: any_log (no vertex in the subgraph points to it).
const SCSG_FULL = {
  objective: 'Make a wooden pickaxe',
  sinks: ['wooden_pickaxe'],
  vertices: [
    {id: 'wooden_pickaxe', qty: 1},
    {id: 'crafting_table', qty: 1},
    {id: 'stick', qty: 4},
    {id: 'any_plank', qty: 12},
    {id: 'any_log', qty: 3},
  ],
  edges: [
    {from: 'any_log', to: 'any_plank', qty: 3, consumed: true},
    {from: 'any_plank', to: 'crafting_table', qty: 4, consumed: true},
    {from: 'any_plank', to: 'stick', qty: 2, consumed: true},
    {from: 'any_plank', to: 'wooden_pickaxe', qty: 3, consumed: true},
    {from: 'stick', to: 'wooden_pickaxe', qty: 2, consumed: true},
    {from: 'crafting_table', to: 'wooden_pickaxe', qty: 1, consumed: false},
  ],
};

// SCSG r=0 with any_log pruned — bot already has logs in inventory.
// Source node: any_plank (any_log was pruned, so any_plank has no incoming
// subgraph edges; its satisfied_inputs should reference the pruned any_log
// edge).
const SCSG_PRUNED = {
  objective: 'Make a wooden pickaxe',
  sinks: ['wooden_pickaxe'],
  vertices: [
    {id: 'wooden_pickaxe', qty: 1},
    {id: 'crafting_table', qty: 1},
    {id: 'stick', qty: 4},
    {id: 'any_plank', qty: 12},
    // any_log absent — satisfied by inventory
  ],
  edges: [
    {from: 'any_plank', to: 'crafting_table', qty: 4, consumed: true},
    {from: 'any_plank', to: 'stick', qty: 2, consumed: true},
    {from: 'any_plank', to: 'wooden_pickaxe', qty: 3, consumed: true},
    {from: 'stick', to: 'wooden_pickaxe', qty: 2, consumed: true},
    {from: 'crafting_table', to: 'wooden_pickaxe', qty: 1, consumed: false},
  ],
};

describe('enrich_subgraph_sources', () => {
  describe('full SCSG (nothing pruned) — source is any_log', () => {
    it('returns exactly one source vertex', () => {
      const sources = enrich_subgraph_sources(SCSG_FULL, WOODEN_PICKAXE_PTD);
      expect(sources).toHaveLength(1);
    });

    it('source vertex is any_log', () => {
      const sources = enrich_subgraph_sources(SCSG_FULL, WOODEN_PICKAXE_PTD);
      expect(sources[0].id).toBe('any_log');
    });

    it('restores item_type from PTD', () => {
      const sources = enrich_subgraph_sources(SCSG_FULL, WOODEN_PICKAXE_PTD);
      expect(sources[0].item_type).toBe('resource');
    });

    it('restores acquisition_dependency from PTD', () => {
      const sources = enrich_subgraph_sources(SCSG_FULL, WOODEN_PICKAXE_PTD);
      expect(sources[0].acquisition_dependency).toBe('none');
    });

    it('has no satisfied_inputs because nothing was pruned', () => {
      const sources = enrich_subgraph_sources(SCSG_FULL, WOODEN_PICKAXE_PTD);
      expect(sources[0].satisfied_inputs).toEqual([]);
    });

    it('snapshot — log output for visual inspection', () => {
      const sources = enrich_subgraph_sources(SCSG_FULL, WOODEN_PICKAXE_PTD);
      console.log(
          '\n[enrich_subgraph_sources] FULL SCSG sources:',
          JSON.stringify(sources, null, 2));
    });
  });

  describe('pruned SCSG (any_log satisfied) — source is any_plank', () => {
    it('returns exactly one source vertex', () => {
      const sources = enrich_subgraph_sources(SCSG_PRUNED, WOODEN_PICKAXE_PTD);
      expect(sources).toHaveLength(1);
    });

    it('source vertex is any_plank', () => {
      const sources = enrich_subgraph_sources(SCSG_PRUNED, WOODEN_PICKAXE_PTD);
      expect(sources[0].id).toBe('any_plank');
    });

    it('restores item_type from PTD', () => {
      const sources = enrich_subgraph_sources(SCSG_PRUNED, WOODEN_PICKAXE_PTD);
      expect(sources[0].item_type).toBe('item');
    });

    it('satisfied_inputs contains the pruned any_log → any_plank edge', () => {
      const sources = enrich_subgraph_sources(SCSG_PRUNED, WOODEN_PICKAXE_PTD);
      const si = sources[0].satisfied_inputs;
      expect(si).toHaveLength(1);
      expect(si[0]).toEqual({
        from: 'any_log',
        type: 'crafting_input',
        qty: 3,
        consumed: true,
      });
    });

    it('non-source vertices (crafting_table, stick, wooden_pickaxe) are excluded',
       () => {
         const sources =
             enrich_subgraph_sources(SCSG_PRUNED, WOODEN_PICKAXE_PTD);
         const ids = sources.map(v => v.id);
         expect(ids).not.toContain('crafting_table');
         expect(ids).not.toContain('stick');
         expect(ids).not.toContain('wooden_pickaxe');
       });

    it('does not mutate the original subgraph or PTD', () => {
      const sub_snap = JSON.stringify(SCSG_PRUNED);
      const ptd_snap = JSON.stringify(WOODEN_PICKAXE_PTD);
      enrich_subgraph_sources(SCSG_PRUNED, WOODEN_PICKAXE_PTD);
      expect(JSON.stringify(SCSG_PRUNED)).toBe(sub_snap);
      expect(JSON.stringify(WOODEN_PICKAXE_PTD)).toBe(ptd_snap);
    });

    it('snapshot — log output for visual inspection', () => {
      const sources = enrich_subgraph_sources(SCSG_PRUNED, WOODEN_PICKAXE_PTD);
      console.log(
          '\n[enrich_subgraph_sources] PRUNED SCSG sources:',
          JSON.stringify(sources, null, 2));
    });
  });

  describe(
      'heavily pruned SCSG (any_log + any_plank satisfied) — two source nodes',
      () => {
        // Bot already has logs AND planks in inventory. Only the three
        // downstream nodes remain: wooden_pickaxe (sink), crafting_table, and
        // stick. Neither crafting_table nor stick has an incoming edge from
        // within the remaining subgraph, so both are sources.
        //
        // Expected satisfied_inputs:
        //   crafting_table ← any_plank (qty:4, crafting_input, consumed)
        //   stick          ← any_plank (qty:2, crafting_input, consumed)
        const SCSG_TWO_SOURCES = {
          objective: 'Make a wooden pickaxe',
          sinks: ['wooden_pickaxe'],
          vertices: [
            {id: 'wooden_pickaxe', qty: 1},
            {id: 'crafting_table', qty: 1},
            {id: 'stick', qty: 4},
            // any_log and any_plank absent — both satisfied by inventory
          ],
          edges: [
            {from: 'stick', to: 'wooden_pickaxe', qty: 2, consumed: true},
            {
              from: 'crafting_table',
              to: 'wooden_pickaxe',
              qty: 1,
              consumed: false
            },
            // any_plank edges removed because any_plank is pruned
          ],
        };

        it('returns exactly two source vertices', () => {
          const sources =
              enrich_subgraph_sources(SCSG_TWO_SOURCES, WOODEN_PICKAXE_PTD);
          expect(sources).toHaveLength(2);
        });

        it('source ids are crafting_table and stick (in any order)', () => {
          const sources =
              enrich_subgraph_sources(SCSG_TWO_SOURCES, WOODEN_PICKAXE_PTD);
          const ids = sources.map(v => v.id).sort();
          expect(ids).toEqual(['crafting_table', 'stick']);
        });

        it('wooden_pickaxe is not a source (has incoming edges from both sources)',
           () => {
             const sources =
                 enrich_subgraph_sources(SCSG_TWO_SOURCES, WOODEN_PICKAXE_PTD);
             expect(sources.map(v => v.id)).not.toContain('wooden_pickaxe');
           });

        it('crafting_table has satisfied_inputs from pruned any_plank', () => {
          const sources =
              enrich_subgraph_sources(SCSG_TWO_SOURCES, WOODEN_PICKAXE_PTD);
          const ct = sources.find(v => v.id === 'crafting_table');
          expect(ct.satisfied_inputs).toEqual([
            {from: 'any_plank', type: 'crafting_input', qty: 4, consumed: true},
          ]);
        });

        it('stick has satisfied_inputs from pruned any_plank', () => {
          const sources =
              enrich_subgraph_sources(SCSG_TWO_SOURCES, WOODEN_PICKAXE_PTD);
          const stick = sources.find(v => v.id === 'stick');
          expect(stick.satisfied_inputs).toEqual([
            {from: 'any_plank', type: 'crafting_input', qty: 2, consumed: true},
          ]);
        });

        it('each source has correct item_type restored from PTD', () => {
          const sources =
              enrich_subgraph_sources(SCSG_TWO_SOURCES, WOODEN_PICKAXE_PTD);
          const ct = sources.find(v => v.id === 'crafting_table');
          const stick = sources.find(v => v.id === 'stick');
          expect(ct.item_type).toBe('workstation');
          expect(stick.item_type).toBe('item');
        });

        it('snapshot — log output for visual inspection', () => {
          const sources =
              enrich_subgraph_sources(SCSG_TWO_SOURCES, WOODEN_PICKAXE_PTD);
          console.log(
              '\n[enrich_subgraph_sources] TWO-SOURCE SCSG sources:',
              JSON.stringify(sources, null, 2));
        });
      });

  it('warns and passes through vertex when id is not in PTD', () => {
    const warn_spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const subgraph_with_ghost = {
      objective: 'test',
      sinks: ['ghost'],
      vertices: [{id: 'ghost', qty: 1}],
      edges: [],
    };
    const sources =
        enrich_subgraph_sources(subgraph_with_ghost, WOODEN_PICKAXE_PTD);
    expect(warn_spy).toHaveBeenCalledWith(expect.stringContaining('ghost'));
    expect(sources[0]).toEqual({id: 'ghost', qty: 1});
    warn_spy.mockRestore();
  });
});
