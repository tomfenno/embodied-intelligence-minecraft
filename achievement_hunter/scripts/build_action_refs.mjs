#!/usr/bin/env node
// Run with npm run build:action-refs
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

export const MASTER_PATH = path.join(
    REPO_ROOT,
    'achievement_hunter/docs/prompts/_shared/actions_reference.master.json',
);

export const ROLE_OUTPUTS = {
  failure_replanner: path.join(
      REPO_ROOT,
      'achievement_hunter/docs/prompts/failure_replanner/actions_reference.json',
      ),
  search_replanner: path.join(
      REPO_ROOT,
      'achievement_hunter/docs/prompts/search_replanner/actions_reference.json',
      ),
};

function deepMerge(base, overlay) {
  if (overlay === null || overlay === undefined) return base;
  if (typeof overlay !== 'object' || Array.isArray(overlay)) {
    return Array.isArray(overlay) ? overlay.slice() : overlay;
  }
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    return deepMerge({}, overlay);
  }
  const out = {...base};
  for (const [k, v] of Object.entries(overlay)) {
    out[k] = deepMerge(base[k], v);
  }
  return out;
}

export function buildRefs(masterJsonText) {
  const master = JSON.parse(masterJsonText);
  if (!Array.isArray(master)) {
    throw new Error('master file must be a JSON array of action entries');
  }
  const outputs =
      Object.fromEntries(Object.keys(ROLE_OUTPUTS).map((r) => [r, []]));
  for (const entry of master) {
    if (!entry.name)
      throw new Error(`master entry missing 'name': ${JSON.stringify(entry)}`);
    if (!Array.isArray(entry.include_in) || entry.include_in.length === 0) {
      throw new Error(
          `master entry ${entry.name} missing or empty 'include_in'`);
    }
    const {include_in, overrides, ...base} = entry;
    for (const role of include_in) {
      if (!(role in outputs)) {
        throw new Error(
            `master entry ${entry.name} references unknown role: ${role}`);
      }
      const final = overrides && overrides[role] ?
          deepMerge(base, overrides[role]) :
          base;
      outputs[role].push(final);
    }
  }
  return outputs;
}

function format(arr) {
  return JSON.stringify(arr, null, 2) + '\n';
}

function main() {
  const check = process.argv.includes('--check');
  const masterText = fs.readFileSync(MASTER_PATH, 'utf8');
  const outputs = buildRefs(masterText);
  let drift = false;
  for (const [role, outPath] of Object.entries(ROLE_OUTPUTS)) {
    const generated = format(outputs[role]);
    const rel = path.relative(REPO_ROOT, outPath);
    if (check) {
      const current =
          fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
      if (current !== generated) {
        console.error(`[drift] ${
            rel} is stale. Run: node achievement_hunter/scripts/build_action_refs.mjs`);
        drift = true;
      } else {
        console.log(`[ok]    ${rel}`);
      }
    } else {
      fs.writeFileSync(outPath, generated);
      console.log(`[wrote] ${rel} (${outputs[role].length} actions)`);
    }
  }
  if (drift) process.exit(1);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
