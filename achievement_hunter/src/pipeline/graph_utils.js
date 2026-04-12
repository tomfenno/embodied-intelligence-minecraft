/**
 * Pure graph transformation and rendering utilities.
 * No I/O, no agent dependencies — all functions take plain data and return
 * plain data or strings.
 */

/**
 * Trims a PTD graph down to only the fields required by the SCSG prompt,
 * reducing token usage. Keeps objective, sinks, vertex {id, qty}, and
 * edge {from, to, qty, consumed}.
 *
 * Example:
 *   const trimmed = trim_graph_for_scsg(ptd_graph);
 *   const prompt = fill_scsg_prompt(trimmed, state);
 */
export function trim_graph_for_scsg(graph) {
  return {
    objective: graph.objective,
    sinks: graph.sinks,
    vertices: graph.vertices.map(({ id, qty }) => ({ id, qty })),
    edges: graph.edges.map(({ from, to, qty, consumed }) => ({ from, to, qty, consumed })),
  };
}

/**
 * Enriches a pruned SCSG subgraph using the original full PTD graph:
 *   - Restores item_type and acquisition_dependency to each vertex
 *   - Restores type to each edge
 *   - Adds satisfied_inputs to each vertex: edges from the original graph
 *     that pointed TO that vertex but whose from-vertex was pruned
 *     (already satisfied by the bot's current state)
 *
 * Example:
 *   const trimmed = trim_graph_for_scsg(ptd_graph);
 *   // ... run scsg to get subgraph ...
 *   const enriched = enrich_subgraph(subgraph, ptd_graph);
 *   // each vertex now has satisfied_inputs: [{ from, type, qty, consumed }]
 */
export function enrich_subgraph(subgraph, original_graph) {
  const vertex_map = new Map(original_graph.vertices.map(v => [v.id, v]));
  const edge_map = new Map(
    original_graph.edges.map(e => [`${e.from}->${e.to}:${e.consumed}`, e])
  );
  const subgraph_ids = new Set(subgraph.vertices.map(v => v.id));

  const vertices = subgraph.vertices.map(v => {
    const original = vertex_map.get(v.id);
    if (!original) {
      console.warn(`enrich_subgraph: no original vertex found for id "${v.id}"`);
      return v;
    }

    const satisfied_inputs = original_graph.edges
      .filter(e => e.to === v.id && !subgraph_ids.has(e.from))
      .map(e => ({ from: e.from, type: e.type, qty: e.qty, consumed: e.consumed }));

    return {
      ...v,
      item_type: original.item_type,
      acquisition_dependency: original.acquisition_dependency,
      satisfied_inputs,
    };
  });

  const edges = subgraph.edges.map(e => {
    const original = edge_map.get(`${e.from}->${e.to}:${e.consumed}`);
    if (!original) {
      console.warn(
        `enrich_subgraph: no original edge found for (${e.from} -> ${e.to}, consumed=${e.consumed})`
      );
      return e;
    }
    return { ...e, type: original.type };
  });

  return { ...subgraph, vertices, edges };
}

/**
 * Converts a graph { objective, sinks, vertices, edges } to a Mermaid LR diagram.
 * Edges are stored as from→to (from is a prerequisite of to), so we display them
 * left-to-right: raw materials on the left, goal sinks on the right.
 */
export function graph_to_mermaid(graph) {
  if (!graph || !graph.vertices || graph.vertices.length === 0) {
    return '```mermaid\ngraph LR\n    empty["(empty graph)"]\n```';
  }

  const lines = ['```mermaid', 'graph LR'];

  for (const v of graph.vertices) {
    const safe_id = _safe_id(v.id);
    const type_tag = v.item_type ? `<br/>[${v.item_type}]` : '';
    lines.push(`    ${safe_id}["${v.id} ×${v.qty}${type_tag}"]`);
  }

  for (const e of graph.edges) {
    const label = e.qty > 1 ? `|"×${e.qty}"| ` : '';
    lines.push(`    ${_safe_id(e.from)} -->${label}${_safe_id(e.to)}`);
  }

  if (graph.sinks) {
    for (const sink of graph.sinks) {
      lines.push(`    style ${_safe_id(sink)} fill:#4CAF50,color:#fff,stroke:#388E3C`);
    }
  }

  lines.push('```');
  return lines.join('\n');
}

/**
 * Converts an arbitrary string into a Mermaid-safe node ID
 * (alphanumeric + underscores only).
 */
export function _safe_id(str) {
  return str.replace(/[^a-zA-Z0-9]/g, '_');
}
