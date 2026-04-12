/**
 * Deterministic State-Conditioned Subgraph computation.
 *
 * Implements the SCSG(G, S) fixed-point algorithm described in
 * docs/prompts/scsg_prompts/scsg_prompt.md as pure JavaScript — no LLM call
 * required. The algorithm prunes PTD vertices whose required items are already
 * present in the bot's inventory, propagating those reductions until no further
 * vertices can be removed.
 *
 * Edge direction: prerequisite → dependent (e.from feeds e.to).
 * Sinks are goal-side vertices with no outgoing edges.
 */

// ── Abstract-class membership tables ─────────────────────────────────────────
// Maps every supported any_* class to the concrete item ids that satisfy it.
// Used by state_satisfied_vertices to sum inventory quantities across a class.
// Add entries here when the PTD prompt introduces new abstract ids.

export const ABSTRACT_CLASS_MEMBERS = {
  any_log: [
    'oak_log', 'spruce_log', 'birch_log', 'jungle_log',
    'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log',
  ],
  any_plank: [
    'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
    'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
    'pale_oak_planks', 'bamboo_planks', 'crimson_planks', 'warped_planks',
  ],
  any_wood_slab: [
    'oak_slab', 'spruce_slab', 'birch_slab', 'jungle_slab',
    'acacia_slab', 'dark_oak_slab', 'mangrove_slab', 'cherry_slab',
    'pale_oak_slab', 'bamboo_slab', 'crimson_slab', 'warped_slab',
  ],
  any_wool: [
    'white_wool', 'orange_wool', 'magenta_wool', 'light_blue_wool',
    'yellow_wool', 'lime_wool', 'pink_wool', 'gray_wool', 'light_gray_wool',
    'cyan_wool', 'purple_wool', 'blue_wool', 'brown_wool', 'green_wool',
    'red_wool', 'black_wool',
  ],
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Computes the State-Conditioned Subgraph of PTD graph G given the bot's
 * current inventory.
 *
 * @param {object} G         - PTD graph { objective, sinks, vertices, edges }.
 *                             Each vertex must have at least { id, qty }.
 *                             Each edge must have at least { from, to, qty, consumed }.
 *                             Extra fields are preserved unchanged.
 * @param {string|object} inventory
 *                           - "Nothing" OR a map of { item_id: count }.
 *
 * @returns {{ r: 1, why: string, final: {vertices, edges} }}
 *            r=1: inventory is "Nothing" — use full graph.
 * @returns {{ r: 2, why: string, final: {vertices: [], edges: []} }}
 *            r=2: all original sinks already satisfied — task complete.
 * @returns {{ r: 0, s: string[], final: {vertices, edges} }}
 *            r=0: normal case — pruned subgraph with remaining work.
 */
export function compute_scsg(G, inventory) {
  // Step 1: Nothing inventory — no pruning possible.
  if (inventory === 'Nothing') {
    return {
      r: 1,
      why: 'S.inventory==Nothing',
      final: { vertices: G.vertices, edges: G.edges },
    };
  }

  const original_sinks = get_sinks(G);
  const original_sink_ids = original_sinks.map(v => v.id);
  const original_sink_id_set = new Set(original_sink_ids);

  // Step 2: all original sinks already satisfied.
  const initially_satisfied_ids = new Set(
    state_satisfied_vertices(G, inventory).map(v => v.id)
  );
  if (original_sinks.every(v => initially_satisfied_ids.has(v.id))) {
    return {
      r: 2,
      why: 'all original sinks satisfied',
      final: { vertices: [], edges: [] },
    };
  }

  // Steps 3–5: fixed-point pruning loop on a mutable deep copy.
  let g_prime = _deep_copy_graph(G);

  while (true) {
    // 5a: vertices whose inventory requirement is already met.
    const v_sat = state_satisfied_vertices(g_prime, inventory);

    // 5b: prune satisfied vertices and propagate qty decrements.
    g_prime = update_quantities_and_prune(v_sat, g_prime);

    // 5c: new sinks — vertices that became sinks after 5b but weren't original sinks.
    const current_sinks = get_sinks(g_prime);
    const v_disc = current_sinks.filter(v => !original_sink_id_set.has(v.id));

    // 5d: prune newly discovered intermediate sinks.
    g_prime = update_quantities_and_prune(v_disc, g_prime);

    // 5e: stop when nothing changed in this iteration.
    if (v_sat.length === 0 && v_disc.length === 0) break;
  }

  return {
    r: 0,
    s: original_sink_ids,
    final: { vertices: g_prime.vertices, edges: g_prime.edges },
  };
}

// ── Algorithm Primitives ──────────────────────────────────────────────────────

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
 * Abstract any_* ids are resolved by summing all concrete class members
 * found in inventory. Unknown any_* classes are treated as unsatisfied
 * (conservative — we'll search for them rather than wrongly skip).
 *
 * @param {{ vertices: object[] }} G
 * @param {object} inventory   Map of { item_id: count }.
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
 * @param {object[]} V_rm  Vertex objects to remove.
 * @param {object}   G     Graph to prune (not mutated — a new graph is returned).
 * @returns {object} New graph after pruning.
 */
export function update_quantities_and_prune(V_rm, G) {
  if (V_rm.length === 0) return G;

  const remove_ids = new Set(V_rm.map(v => v.id));

  // Compute qty decrements: for each consumed edge into a removed vertex,
  // decrement the upstream vertex's qty.
  const dec = new Map();
  for (const e of G.edges) {
    if (remove_ids.has(e.to) && e.consumed) {
      dec.set(e.from, (dec.get(e.from) ?? 0) + e.qty);
    }
  }

  const vertices = G.vertices
    .filter(v => !remove_ids.has(v.id))
    .map(v => dec.has(v.id) ? { ...v, qty: v.qty - dec.get(v.id) } : v);

  const edges = G.edges.filter(
    e => !remove_ids.has(e.from) && !remove_ids.has(e.to)
  );

  return { ...G, vertices, edges };
}

// ── Internal Helpers ──────────────────────────────────────────────────────────

/**
 * Returns true if the inventory satisfies a single vertex's qty requirement.
 * Handles abstract any_* ids via ABSTRACT_CLASS_MEMBERS; unknown any_* ids
 * are conservatively treated as unsatisfied.
 */
function _inventory_satisfies(vertex, inventory) {
  if (vertex.id.startsWith('any_')) {
    const members = ABSTRACT_CLASS_MEMBERS[vertex.id];
    if (!members) return false; // Unknown abstract class — treat as unsatisfied.
    const total = members.reduce((sum, item) => sum + (inventory[item] ?? 0), 0);
    return total >= vertex.qty;
  }
  return (inventory[vertex.id] ?? 0) >= vertex.qty;
}

/**
 * Returns a deep copy of a graph. Only vertices and edges are deep-copied;
 * other top-level fields are shallow-copied.
 */
function _deep_copy_graph(G) {
  return {
    ...G,
    vertices: G.vertices.map(v => ({ ...v })),
    edges: G.edges.map(e => ({ ...e })),
  };
}
