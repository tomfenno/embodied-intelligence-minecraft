import {ABSTRACT_CLASS_MEMBERS, ITEM_SYNONYMS} from './mc_sources.js';

// Extra units of each vertex to acquire beyond the recipe requirement.
// Bumps the SCSG-computed remaining-work qty so the agent collects a buffer
// that survives normal recipe consumption — useful e.g. as spare wood for
// re-crafting a pickaxe mid-rollout. The buffer applies only to acquisition
// (vertex qty); recipe edges (e.g. any_log → any_plank) are left untouched
// so downstream craft tasks still consume only the recipe-required amount.
const BUFFER_QTY_BY_ID = {any_log: 2};

// Compute the remaining-work subgraph for the current inventory state.
export function compute_scsg(graph, inventory) {
  if (inventory === 'Nothing') {
    return {
      r: 1,
      why: 'S.inventory==Nothing',
      final: clone_graph_content(graph),
    };
  }

  const original_sinks = get_sinks(graph);
  const original_sink_ids = original_sinks.map(({id}) => id);
  const original_sink_id_set = new Set(original_sink_ids);
  const initially_satisfied_id_set =
      new Set(state_satisfied_vertices(graph, inventory).map(({id}) => id));

  if (original_sink_ids.every(id => initially_satisfied_id_set.has(id))) {
    return {r: 2, why: 'all original sinks satisfied', final: empty_graph()};
  }

  let pruned_graph = deep_copy_graph(graph);
  for (const vertex of pruned_graph.vertices) {
    vertex.qty += BUFFER_QTY_BY_ID[vertex.id] ?? 0;
  }
  update_quantities_from_state(pruned_graph, inventory);

  while (true) {
    const satisfied_vertices =
        state_satisfied_vertices(pruned_graph, inventory);
    pruned_graph =
        update_quantities_and_prune(satisfied_vertices, pruned_graph);

    const disconnected_sinks =
        get_sinks(pruned_graph).filter(({id}) => !original_sink_id_set.has(id));
    pruned_graph =
        update_quantities_and_prune(disconnected_sinks, pruned_graph);

    if (!satisfied_vertices.length && !disconnected_sinks.length) break;
  }

  const remaining_work_graph = normalize_remaining_work_graph(
      pruned_graph, inventory, original_sink_id_set);

  return remaining_work_graph.vertices.length ?
      {r: 0, s: original_sink_ids, final: remaining_work_graph} :
      {r: 2, why: 'all original sinks satisfied', final: remaining_work_graph};
}

// Return vertices with no outgoing edges.
function get_sinks(graph) {
  const has_outgoing = new Set();
  for (const {from} of graph.edges) has_outgoing.add(from);
  return graph.vertices.filter(({id}) => !has_outgoing.has(id));
}

// Return vertices already satisfied by inventory.
function state_satisfied_vertices(graph, inventory) {
  const satisfied_vertices = [];
  for (const vertex of graph.vertices) {
    if (inventory_satisfies(vertex, inventory)) satisfied_vertices.push(vertex);
  }
  return satisfied_vertices;
}

// Remove vertices, decrement consumed prerequisites, and prune edges.
function update_quantities_and_prune(removed_vertices, graph) {
  if (!removed_vertices.length) return graph;

  const removed_id_set = new Set(removed_vertices.map(({id}) => id));
  const decrement_by_id = new Map();
  const edges = [];

  for (const edge of graph.edges) {
    if (removed_id_set.has(edge.to) && edge.consumed) {
      decrement_by_id.set(
          edge.from, (decrement_by_id.get(edge.from) ?? 0) + edge.qty);
    }
    if (!removed_id_set.has(edge.from) && !removed_id_set.has(edge.to)) {
      edges.push({...edge});
    }
  }

  const vertices = [];
  for (const vertex of graph.vertices) {
    if (removed_id_set.has(vertex.id)) continue;
    const decrement = decrement_by_id.get(vertex.id) ?? 0;
    vertices.push(
        decrement ? {...vertex, qty: Math.max(0, vertex.qty - decrement)} :
                    {...vertex});
  }

  return {...graph, vertices, edges};
}

// Count concrete or abstract inventory for an item id.
// - Abstract ids (`any_*`): sum across ABSTRACT_CLASS_MEMBERS.
// - Concrete ids with synonyms (e.g. `egg` ↔ `brown_egg` ↔ `blue_egg`):
//   sum across ITEM_SYNONYMS members so the SCSG treats functionally-
//   interchangeable items as one. The synonym relation is symmetric —
//   a graph asking for `brown_egg` is also satisfied by `egg` /
//   `blue_egg`.
// - Plain concrete ids: direct inventory lookup.
function inventory_count(id, inventory) {
  if (id.startsWith('any_')) {
    let total = 0;
    for (const member_id of ABSTRACT_CLASS_MEMBERS[id] ?? []) {
      total += inventory[member_id] ?? 0;
    }
    return total;
  }
  const synonyms = ITEM_SYNONYMS[id];
  if (synonyms) {
    let total = 0;
    for (const synonym of synonyms) total += inventory[synonym] ?? 0;
    return total;
  }
  return inventory[id] ?? 0;
}

// Check whether inventory meets a vertex quantity.
function inventory_satisfies(vertex, inventory) {
  return inventory_count(vertex.id, inventory) >= vertex.qty;
}

// Scale incoming consumed edges for partially satisfied vertices.
function update_quantities_from_state(graph, inventory) {
  const vertex_by_id = new Map();
  for (const vertex of graph.vertices) {
    if (!vertex_by_id.has(vertex.id)) vertex_by_id.set(vertex.id, vertex);
  }

  const incoming_consumed_edges_by_id = new Map();
  for (const edge of graph.edges) {
    if (!edge.consumed) continue;
    const incoming_edges = incoming_consumed_edges_by_id.get(edge.to);
    if (incoming_edges)
      incoming_edges.push(edge);
    else
      incoming_consumed_edges_by_id.set(edge.to, [edge]);
  }

  for (const vertex of graph.vertices) {
    const inventory_qty = inventory_count(vertex.id, inventory);
    if (inventory_qty <= 0 || inventory_qty >= vertex.qty) continue;

    const scale = (vertex.qty - inventory_qty) / vertex.qty;
    for (const edge of incoming_consumed_edges_by_id.get(vertex.id) ?? []) {
      const original_edge_qty = edge.qty;
      const next_edge_qty = Math.ceil(original_edge_qty * scale);
      edge.qty = next_edge_qty;

      const upstream_vertex = vertex_by_id.get(edge.from);
      if (upstream_vertex) {
        upstream_vertex.qty = Math.max(
            0, upstream_vertex.qty - (original_edge_qty - next_edge_qty));
      }
    }
  }
}

// Recompute the stabilized graph so quantities mean remaining work.
function normalize_remaining_work_graph(
    graph, inventory, original_sink_id_set) {
  let normalized_graph = deep_copy_graph(graph);

  while (true) {
    const previous_signature = graph_signature(normalized_graph);
    normalized_graph = recompute_returned_vertex_quantities(
        normalized_graph, inventory, original_sink_id_set);
    normalized_graph = remove_zero_qty_vertices(normalized_graph);
    normalized_graph = remove_irrelevant_intermediate_sinks(
        normalized_graph, original_sink_id_set);
    if (previous_signature === graph_signature(normalized_graph)) {
      return normalized_graph;
    }
  }
}

// Recalculate each surviving vertex's remaining required quantity.
function recompute_returned_vertex_quantities(
    graph, inventory, original_sink_id_set) {
  const outgoing_consumed_qty_by_id = new Map();
  const reusable_vertex_id_set = new Set();

  for (const {from, qty, consumed} of graph.edges) {
    if (consumed) {
      outgoing_consumed_qty_by_id.set(
          from, (outgoing_consumed_qty_by_id.get(from) ?? 0) + qty);
    } else {
      reusable_vertex_id_set.add(from);
    }
  }

  return {
    ...graph,
    vertices: graph.vertices.map(
        vertex => ({
          ...vertex,
          qty: Math.max(
              0,
              (original_sink_id_set.has(vertex.id) ||
                       reusable_vertex_id_set.has(vertex.id) ||
                       BUFFER_QTY_BY_ID[vertex.id] ?
                   vertex.qty :
                   (outgoing_consumed_qty_by_id.get(vertex.id) ?? 0)) -
                  inventory_count(vertex.id, inventory)),
        })),
  };
}

// Drop vertices with no remaining work and their edges.
function remove_zero_qty_vertices(graph) {
  const vertices = graph.vertices.filter(({qty}) => qty > 0);
  const keep_id_set = new Set(vertices.map(({id}) => id));
  return {
    ...graph,
    vertices,
    edges: graph.edges.filter(
        ({from, to}) => keep_id_set.has(from) && keep_id_set.has(to)),
  };
}

// Repeatedly prune non-goal sinks exposed by earlier removals.
function remove_irrelevant_intermediate_sinks(graph, original_sink_id_set) {
  let pruned_graph = graph;

  while (true) {
    const removed_id_set =
        new Set(get_sinks(pruned_graph)
                    .filter(({id}) => !original_sink_id_set.has(id))
                    .map(({id}) => id));
    if (!removed_id_set.size) return pruned_graph;
    pruned_graph = {
      ...pruned_graph,
      vertices: pruned_graph.vertices.filter(({id}) => !removed_id_set.has(id)),
      edges: pruned_graph.edges.filter(
          ({from, to}) => !removed_id_set.has(from) && !removed_id_set.has(to)),
    };
  }
}

// Build a stable graph fingerprint for fixed-point convergence.
function graph_signature(graph) {
  return `${
      graph.vertices.map(({id, qty}) => `${id}:${qty}`).sort().join('|')}||${
      graph.edges
          .map(
              ({from, to, type, qty, consumed}) =>
                  `${from}->${to}:${type}:${qty}:${consumed ? 1 : 0}`)
          .sort()
          .join('|')}`;
}

// Deep-copy graph structure and payload objects.
function deep_copy_graph(graph) {
  return {
    ...graph,
    vertices: graph.vertices.map(vertex => ({...vertex})),
    edges: graph.edges.map(edge => ({...edge})),
  };
}

// Return an empty graph payload.
function empty_graph() {
  return {vertices: [], edges: []};
}

// Clone only the public graph content fields.
function clone_graph_content(graph) {
  return {
    vertices: graph.vertices.map(vertex => ({...vertex})),
    edges: graph.edges.map(edge => ({...edge})),
  };
}
