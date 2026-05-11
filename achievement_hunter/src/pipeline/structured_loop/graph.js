import {ABSTRACT_CLASS_MEMBERS} from '../mc_sources.js';

export function build_incoming_edge_map(edges) {
  const incoming_edge_map = new Map();
  for (const edge of edges) {
    const incoming = incoming_edge_map.get(edge.to);
    incoming ? incoming.push(edge) : incoming_edge_map.set(edge.to, [edge]);
  }
  return incoming_edge_map;
}

export function edge_key(from, to, type) {
  return `${from}→${to}→${type}`;
}

export function edge_in_subgraph(edge, subgraph_edge_set) {
  return subgraph_edge_set.has(edge_key(edge.from, edge.to, edge.type));
}

export function get_satisfied_inputs_by_type(candidate, type) {
  return (candidate.satisfied_inputs ?? [])
      .filter(input => input.type === type)
      .map(({item, qty}) => ({item, qty}));
}

export function get_single_satisfied_input_item(candidate, type) {
  return (candidate.satisfied_inputs ?? [])
             .find(input => input.type === type)
             ?.item ??
      null;
}

export function resolve_concrete_craft_target(candidate_id, craftable_items) {
  if (!candidate_id.startsWith('any_')) {
    return craftable_items.includes(candidate_id) ? candidate_id : null;
  }

  const members = ABSTRACT_CLASS_MEMBERS[candidate_id] ?? [];
  return craftable_items.find(item => members.includes(item)) ?? null;
}
