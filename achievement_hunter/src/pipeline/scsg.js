/**
 * Deterministic State-Conditioned Subgraph computation.
 *
 * Implements the original SCSG fixed-point pruning algorithm, then normalizes
 * the returned graph so it represents REMAINING WORK.
 *
 * Edge direction: prerequisite → dependent (e.from feeds e.to).
 * Sinks are goal-side vertices with no outgoing edges.
 */

// ── Abstract-class membership tables ─────────────────────────────────────────

export const ABSTRACT_CLASS_MEMBERS = {
  any_log: [
    'oak_log',
    'spruce_log',
    'birch_log',
    'jungle_log',
    'acacia_log',
    'dark_oak_log',
    'mangrove_log',
    'cherry_log',
    'pale_oak_log',
  ],
  any_plank: [
    'oak_planks',
    'spruce_planks',
    'birch_planks',
    'jungle_planks',
    'acacia_planks',
    'dark_oak_planks',
    'mangrove_planks',
    'cherry_planks',
    'pale_oak_planks',
    'bamboo_planks',
    'crimson_planks',
    'warped_planks',
  ],
  any_wood_slab: [
    'oak_slab',
    'spruce_slab',
    'birch_slab',
    'jungle_slab',
    'acacia_slab',
    'dark_oak_slab',
    'mangrove_slab',
    'cherry_slab',
    'pale_oak_slab',
    'bamboo_slab',
    'crimson_slab',
    'warped_slab',
  ],
  any_wool: [
    'white_wool',
    'orange_wool',
    'magenta_wool',
    'light_blue_wool',
    'yellow_wool',
    'lime_wool',
    'pink_wool',
    'gray_wool',
    'light_gray_wool',
    'cyan_wool',
    'purple_wool',
    'blue_wool',
    'brown_wool',
    'green_wool',
    'red_wool',
    'black_wool',
  ],
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Computes the State-Conditioned Subgraph of PTD graph G given the bot's
 * current inventory.
 *
 * @param {object} G
 *   PTD graph { objective, sinks, vertices, edges }.
 * @param {string|object} inventory
 *   "Nothing" OR a map of { item_id: count }.
 *
 * @returns {{ r: 1, why: string, final: {vertices, edges} }}
 * @returns {{ r: 2, why: string, final: {vertices: [], edges: []} }}
 * @returns {{ r: 0, s: string[], final: {vertices, edges} }}
 */
export function compute_scsg(G, inventory) {
  // Step 1: Nothing inventory — no pruning possible.
  if (inventory === 'Nothing') {
    return {
      r: 1,
      why: 'S.inventory==Nothing',
      final: {
        vertices: G.vertices.map(v => ({...v})),
        edges: G.edges.map(e => ({...e})),
      },
    };
  }

  const original_sinks = get_sinks(G);
  const original_sink_ids = original_sinks.map(v => v.id);
  const original_sink_id_set = new Set(original_sink_ids);

  // Step 2: all original sinks already satisfied.
  const initially_satisfied_ids =
      new Set(state_satisfied_vertices(G, inventory).map(v => v.id));
  if (original_sinks.every(v => initially_satisfied_ids.has(v.id))) {
    return {
      r: 2,
      why: 'all original sinks satisfied',
      final: {vertices: [], edges: []},
    };
  }

  // Steps 3–5: original fixed-point pruning loop on a mutable deep copy.
  let g_prime = _deep_copy_graph(G);
  _update_quantities_from_state(g_prime, inventory);

  while (true) {
    const v_sat = state_satisfied_vertices(g_prime, inventory);
    g_prime = update_quantities_and_prune(v_sat, g_prime);

    const current_sinks = get_sinks(g_prime);
    const v_disc = current_sinks.filter(v => !original_sink_id_set.has(v.id));
    g_prime = update_quantities_and_prune(v_disc, g_prime);

    if (v_sat.length === 0 && v_disc.length === 0) break;
  }

  // Normalize the stabilized pruned graph into a "remaining work" graph.
  const normalized =
      _normalize_remaining_work_graph(g_prime, inventory, original_sink_id_set);

  if (normalized.vertices.length === 0) {
    return {
      r: 2,
      why: 'all original sinks satisfied',
      final: normalized,
    };
  }

  return {
    r: 0,
    s: original_sink_ids,
    final: normalized,
  };
}

// ── Algorithm Primitives ─────────────────────────────────────────────────────

/**
 * GET_SINKS(G): vertices with no outgoing edges.
 * An edge e.from = v.id means v feeds something, so v is not a sink.
 *
 * @param {{ vertices: object[], edges: object[] }} G
 * @returns {object[]} Vertex objects that are sinks.
 */
export function get_sinks(G) {
  const has_outgoing = new Set(G.edges.map(e => e.from));
  return G.vertices.filter(v => !has_outgoing.has(v.id));
}

/**
 * STATE_SATISFIED_VERTICES(G, inventory): vertices whose required qty is
 * already present in inventory.
 *
 * Abstract any_* ids are resolved by summing all concrete class members found
 * in inventory. Unknown any_* classes are treated as unsatisfied.
 *
 * @param {{ vertices: object[] }} G
 * @param {object} inventory
 * @returns {object[]} Vertices whose inventory requirement is met.
 */
export function state_satisfied_vertices(G, inventory) {
  return G.vertices.filter(v => _inventory_satisfies(v, inventory));
}

/**
 * UPDATE_QUANTITIES_AND_PRUNE(V_rm, G):
 *   1. Decrements the qty of each upstream vertex for every consumed edge
 *      that pointed to a removed vertex.
 *   2. Removes all edges to/from removed vertices.
 *   3. Removes the vertices themselves.
 *
 * Kept exactly in line with the original algorithm’s behavior.
 *
 * @param {object[]} V_rm
 * @param {object} G
 * @returns {object}
 */
export function update_quantities_and_prune(V_rm, G) {
  if (V_rm.length === 0) return G;

  const remove_ids = new Set(V_rm.map(v => v.id));

  const dec = new Map();
  for (const e of G.edges) {
    if (remove_ids.has(e.to) && e.consumed) {
      dec.set(e.from, (dec.get(e.from) ?? 0) + e.qty);
    }
  }

  const vertices = G.vertices.filter(v => !remove_ids.has(v.id))
                       .map(
                           v => dec.has(v.id) ?
                               {...v, qty: Math.max(0, v.qty - dec.get(v.id))} :
                               {...v});

  const edges =
      G.edges.filter(e => !remove_ids.has(e.from) && !remove_ids.has(e.to))
          .map(e => ({...e}));

  return {...G, vertices, edges};
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Returns how many units of id are present in inventory.
 * Handles abstract any_* ids by summing all concrete class members.
 * Unknown any_* classes return 0.
 */
function _inventory_count(id, inventory) {
  if (id.startsWith('any_')) {
    const members = ABSTRACT_CLASS_MEMBERS[id] ?? [];
    return members.reduce((sum, item) => sum + (inventory[item] ?? 0), 0);
  }
  return inventory[id] ?? 0;
}

/**
 * Returns true if the inventory satisfies a single vertex's qty requirement.
 */
function _inventory_satisfies(vertex, inventory) {
  return _inventory_count(vertex.id, inventory) >= vertex.qty;
}

/**
 * Original structural pre-pass:
 *
 * For each partially satisfied vertex, scale each incoming consumed edge
 * proportionally to the remaining unmet fraction of that vertex and reduce
 * the upstream vertex qty by the no-longer-needed amount.
 *
 * Important: this DOES NOT reduce the partially satisfied vertex's own qty.
 */
function _update_quantities_from_state(G, inventory) {
  for (const vertex of G.vertices) {
    const have = _inventory_count(vertex.id, inventory);
    if (have <= 0 || have >= vertex.qty) continue;

    const scale = (vertex.qty - have) / vertex.qty;

    for (const edge of G.edges) {
      if (edge.to !== vertex.id || !edge.consumed) continue;

      const original_edge_qty = edge.qty;
      edge.qty = Math.ceil(original_edge_qty * scale);

      const upstream = G.vertices.find(v => v.id === edge.from);
      if (upstream) {
        upstream.qty =
            Math.max(0, upstream.qty - (original_edge_qty - edge.qty));
      }
    }
  }
}

/**
 * Normalize the stabilized pruned graph so it directly represents remaining
 * work still to be done.
 *
 * Rules:
 * - Original sinks: remaining unmet qty after inventory.
 * - Vertices with surviving outgoing non-consumed edges: remaining required
 *   reusable qty after inventory.
 * - Consumable non-sink vertices: remaining outgoing consumed demand after
 *   inventory.
 *
 * Then remove zero-work vertices and repeatedly prune newly exposed
 * non-original sinks.
 */
function _normalize_remaining_work_graph(G, inventory, original_sink_id_set) {
  let h = _deep_copy_graph(G);

  while (true) {
    const prev_signature = _graph_signature(h);

    h = _recompute_returned_vertex_quantities(
        h, inventory, original_sink_id_set);
    h = _remove_zero_qty_vertices(h);
    h = _remove_irrelevant_intermediate_sinks(h, original_sink_id_set);

    const next_signature = _graph_signature(h);
    if (prev_signature === next_signature) break;
  }

  return h;
}

function _recompute_returned_vertex_quantities(
    G, inventory, original_sink_id_set) {
  const outgoing_map = _build_outgoing_edge_map(G.edges);

  const vertices = G.vertices.map(v => {
    const outgoing = outgoing_map.get(v.id) ?? [];
    const outgoing_consumed_qty =
        outgoing.filter(e => e.consumed).reduce((sum, e) => sum + e.qty, 0);
    const has_outgoing_nonconsumed = outgoing.some(e => !e.consumed);
    const inv_count = _inventory_count(v.id, inventory);

    let qty;

    if (original_sink_id_set.has(v.id)) {
      qty = Math.max(0, v.qty - inv_count);
    } else if (has_outgoing_nonconsumed) {
      // Reusable dependency still required by at least one surviving outgoing
      // non-consumed edge; subtract what inventory already satisfies.
      qty = Math.max(0, v.qty - inv_count);
    } else {
      // Consumable non-sink: remaining work is the surviving outgoing consumed
      // demand minus what inventory already covers.
      qty = Math.max(0, outgoing_consumed_qty - inv_count);
    }

    return {...v, qty};
  });

  return {...G, vertices};
}

function _remove_zero_qty_vertices(G) {
  const keep_vertices = G.vertices.filter(v => v.qty > 0);
  const keep_ids = new Set(keep_vertices.map(v => v.id));

  const keep_edges =
      G.edges.filter(e => keep_ids.has(e.from) && keep_ids.has(e.to));

  return {
    ...G,
    vertices: keep_vertices,
    edges: keep_edges,
  };
}

function _remove_irrelevant_intermediate_sinks(G, original_sink_id_set) {
  let h = _deep_copy_graph(G);

  while (true) {
    const sinks = get_sinks(h);
    const remove_ids = new Set(
        sinks.filter(v => !original_sink_id_set.has(v.id)).map(v => v.id));

    if (remove_ids.size === 0) break;

    h = {
      ...h,
      vertices: h.vertices.filter(v => !remove_ids.has(v.id)),
      edges:
          h.edges.filter(e => !remove_ids.has(e.from) && !remove_ids.has(e.to)),
    };
  }

  return h;
}

function _build_outgoing_edge_map(edges) {
  const m = new Map();
  for (const e of edges) {
    if (!m.has(e.from)) m.set(e.from, []);
    m.get(e.from).push(e);
  }
  return m;
}

function _graph_signature(G) {
  const v_sig = G.vertices.map(v => `${v.id}:${v.qty}`).sort().join('|');

  const e_sig =
      G.edges
          .map(
              e =>
                  `${e.from}->${e.to}:${e.type}:${e.qty}:${e.consumed ? 1 : 0}`)
          .sort()
          .join('|');

  return `${v_sig}||${e_sig}`;
}

function _deep_copy_graph(G) {
  return {
    ...G,
    vertices: G.vertices.map(v => ({...v})),
    edges: G.edges.map(e => ({...e})),
  };
}