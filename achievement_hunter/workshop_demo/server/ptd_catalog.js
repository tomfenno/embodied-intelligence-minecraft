// Catalog of pre-generated PTDs (achievement_hunter/docs/ptd_jsons/) for the
// workshop demo's selection screen. No LLM call involved — these are the
// same files structured_loop can already load from disk via
// PTD_JSON_OVERRIDE_PATH (see achievement_hunter/workshop_demo/PLAN.md,
// Phase 2).

import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PTD_JSON_DIR = path.resolve(__dirname, '../../docs/ptd_jsons');

// Restricts the demo to the achievements in
// achievement_hunter/evaluation_harness/advancement_tester.json, minus
// oh_shiny (the golden apple) — a deliberate curation, not derived
// automatically from that file, since matching its `goal` text to a PTD
// filename isn't 1:1 (several PTDs have near-duplicate objectives with
// different wording, e.g. cook_a_pork_chop.json vs cook_a_porkchop.json —
// only the former matches advancement_tester.json's exact phrasing).
// Resolved by comparing each PTD's "objective" field against
// advancement_tester.json's "goal" text directly, not by filename pattern.
//
// Ordered simplest to most complex, measured from each PTD's own graph
// (vertex count primary, edge count as tiebreak) rather than guessed from
// the achievement names — this is also the order the selection UI shows
// them in (listPtdFiles() preserves this order, does not re-sort):
//
//   file                                  vertices  edges  max depth
//   construct_..._same_material.json         8        15       4
//   cook_a_pork_chop.json                     9        12       7
//   smelt_an_iron_ingot_...json              10        16       8
//   fill_a_bucket_with_lava_...json          12        19      10
//   acquire_diamonds_...json                 12        20      10
//   acquire_a_diamond_chestplate_...json     14        23      11
//   obtain_a_block_of_obsidian_...json       16        28      12
const ALLOWED_PTD_FILES = [
  // moar_tools
  'construct_one_pickaxe_one_shovel_one_axe_and_one_hoe_with_the_same_material.json',
  // pork_chop
  'cook_a_pork_chop.json',
  // acquire_hardware
  'smelt_an_iron_ingot_have_an_iron_ingot_in_the_inventory.json',
  // hot_stuff
  'fill_a_bucket_with_lava_have_a_lava_bucket_in_the_inventory.json',
  // diamonds
  'acquire_diamonds_have_a_diamond_in_the_inventory.json',
  // cover_me_in_diamonds
  'acquire_a_diamond_chestplate_have_a_diamond_chestplate_in_the_inventory.json',
  // ice_bucket_challenge
  'obtain_a_block_of_obsidian_have_a_block_of_obsidian_in_the_inventory.json',
  // oh_shiny (golden apple) deliberately excluded.
];

// Preserves ALLOWED_PTD_FILES's simplest-to-most-complex order — no re-sort.
export function listPtdFiles() {
  const onDisk = new Set(
      fs.readdirSync(PTD_JSON_DIR).filter((name) => name.endsWith('.json')));
  return ALLOWED_PTD_FILES.filter((name) => onDisk.has(name));
}

export function ptdFilePath(filename) {
  return path.join(PTD_JSON_DIR, filename);
}

// Repo-root-relative path, matching the shape PTD_JSON_OVERRIDE_PATH expects
// elsewhere in the codebase (see structured_loop/config.js).
export function ptdRelativePath(filename) {
  return `achievement_hunter/docs/ptd_jsons/${filename}`;
}

// Derives a human-readable objective sentence from a PTD filename, e.g.
// "cook_a_porkchop.json" -> "Cook a porkchop.". This is sent to the agent
// as the chat objective; since PTD_JSON_OVERRIDE_PATH bypasses the
// to_snake_case(objective) -> filename lookup entirely, the exact wording
// only affects display/logging, not which PTD actually loads.
export function objectiveFromPtdFilename(filename) {
  const base = filename.replace(/\.json$/, '');
  const sentence = base.split('_').join(' ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}
