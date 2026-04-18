/**
 * Pure graph transformation and rendering utilities.
 * No I/O, no agent dependencies — all functions take plain data and return
 * plain data or strings.
 */

/**
 * Converts a graph { objective, sinks, vertices, edges } to a Mermaid LR
 * diagram. Edges are stored as from→to (from is a prerequisite of to), so we
 * display them left-to-right: raw materials on the left, goal sinks on the
 * right.
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
      lines.push(
          `    style ${_safe_id(sink)} fill:#4CAF50,color:#fff,stroke:#388E3C`);
    }
  }

  lines.push('```');
  return lines.join('\n');
}

function _safe_id(str) {
  return str.replace(/[^a-zA-Z0-9]/g, '_');
}
