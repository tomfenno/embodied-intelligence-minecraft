// Centralised action-result message construction.
//
// Every action result that flows into the failure_replanner or
// search_replanner LLM prompts is shaped here. Per the plan in
// docs/replanner_action_result_messages.md:
//
//   - One place to upgrade regex-based parsing of upstream skill
//     output (mineflayer-pathfinder / Mindcraft skills.js). The
//     project already commented on this fragility next to
//     PATHFINDING_MESSAGE_REGEX in command_utils.js; this module
//     supersedes ad-hoc parsing at call sites.
//
//   - Stable, machine-parseable headlines so the LLM can pick up
//     `key=value` pairs without parsing prose. Every builder emits
//     `<kind>: <headline> [| "<skill tail>"]`.
//
//   - Forward-compatible: builders accept optional fields (e.g.
//     `mode_reasons` in build_mode_interrupted_message) so later plan
//     steps can grow the headline without breaking parsers.
//
//   - Token-cap is a guideline, not enforced — skill tails truncate
//     softly at ~200 chars, but headlines are not asserted in tests.
//
// Each builder is pure: same inputs → same output, no I/O, no agent
// reads. Call sites (Step 4 / Step 7 / Step 5 / etc.) are responsible
// for snapshotting agent state and threading it in.

// ── Skill-output parser ──────────────────────────────────────────────

// Upstream skill log helper prepends "Action output:\n" to every blob;
// strip it before splitting into lines.
const ACTION_OUTPUT_PREFIX = /^Action output:\s*/;

// Recognised upstream patterns. Keeping them adjacent makes it obvious
// what is being depended on, and the `unknown` fallback in
// parse_skill_output ensures any unrecognised line still produces a
// usable last_line + root_cause_kind='unknown' (never crashes).
const PLACE_FAILED_RE = /Failed to place (\S+) at \(([^)]+)\)\.?/i;
const WORKSTATION_MISSING_RE =
    /There is no (\S+) nearby and you have no \1\b/i;
const SMELT_INPUT_RE = /You do not have enough (\S+) to smelt/i;
const FUEL_MISSING_RE = /You have no fuel to smelt/i;
const TOOL_MISSING_RE =
    /Don'?t have (?:the )?right tools to harvest (\S+?)\.?$/i;
const INVENTORY_FULL_RE = /Inventory full/i;

const FOUND_BLOCK_AT_RE = /Found \S+ at \(([^)]+)\)\. Navigating/i;
const FOUND_ENTITY_DIST_RE = /Found \S+ ([\d.]+) blocks? away\b/i;

const PATHFINDER_BAIL_RE =
    /no path|PathStopped|Could not find a path|Path not found|Pathfinding stopped|Took to long to decide path/i;
const NO_TOOL_RE = /Cannot break (\S+) with current tools/i;

/**
 * Parse an upstream skill-output blob into structured fields. Every
 * field is optional except `last_line`; callers should check for
 * presence and degrade gracefully on absence.
 *
 * Returns:
 *   last_line:              string | null — last non-empty line, trimmed
 *   place_failed_at:        {workstation, x, y, z} — from "Failed to place X at (...)"
 *   missing_workstation:    string — from "There is no X nearby and you have no X"
 *   smelt_input_missing:    string item name — from "You do not have enough X to smelt"
 *   fuel_missing:           true — from "You have no fuel to smelt"
 *   tool_missing_for:       string block name — from "Don't have right tools to harvest X"
 *   inventory_full:         true — from "Inventory full"
 *   located_at:             {x, y, z} — from "Found <X> at (...)"
 *   located_distance:       number — from "Found <X> N blocks away"
 *   blocker_kind:           'no_tool' | 'pathfinder_bail'
 *   blocker_detail:         verbatim source line for the matched blocker
 *   no_tool_for:            block name from NO_TOOL_RE
 *   root_cause_kind:        derived kind for command_failure messages;
 *                           'unknown' when no pattern matched
 *   root_cause_detail:      free-form supplement to root_cause_kind
 */
// Priority order for root_cause_kind selection. Earlier entries beat
// later ones when the same blob carries multiple diagnostic lines.
// Most specific causes (workstation placement failed AT a specific
// position) precede broader ones (generic pathfinder bail). `unknown`
// is implicit — it only fires when nothing in this list matched.
const ROOT_CAUSE_PRIORITY = [
  'workstation_placement_failed',
  'workstation_missing',
  'insufficient_smelt_input',
  'fuel_missing',
  'tool_missing',
  'inventory_full',
  'pathfinder_bail',
];

// Kinds whose `root_cause=` headline already embeds the line-specific
// supplement (e.g. `workstation_placement_failed at (104,130,-24)`
// carries the coords from the line itself). For these, a secondary
// diagnostic line is a better tail than the primary one because it
// adds non-redundant information.
const HEADLINE_EMBEDS_PRIMARY_LINE = new Set([
  'workstation_placement_failed',
]);

export function parse_skill_output(skill_output) {
  if (typeof skill_output !== 'string' || skill_output.length === 0) {
    return {last_line: null, root_cause_kind: 'unknown'};
  }

  const body = skill_output.replace(ACTION_OUTPUT_PREFIX, '');
  const lines = body.split('\n').map(s => s.trim()).filter(Boolean);
  const out = {last_line: lines.at(-1) ?? null};

  // Evidence-based root_cause derivation. Each pattern match appends
  // one entry to `evidence`, carrying the verbatim line that
  // established it. After the scan, the highest-priority entry wins
  // and contributes both the kind/detail (headline) and a `root_cause_line`
  // (preferred tail when non-redundant). The next-highest-priority
  // entry contributes `secondary_line` — used as the tail when the
  // chosen kind's headline already embeds the primary line's data.
  // Adding a new pattern is one push() at match time + one priority
  // list entry; no else-if chain to extend.
  const evidence = [];

  for (const line of lines) {
    let m;

    if (!out.place_failed_at && (m = line.match(PLACE_FAILED_RE))) {
      const coords = m[2].split(',').map(s => parseFloat(s.trim()));
      out.place_failed_at = {
        workstation: m[1],
        x: coords[0],
        y: coords[1],
        z: coords[2],
      };
      evidence.push(
          {kind: 'workstation_placement_failed', line, detail: null});
    }
    if (!out.missing_workstation &&
        (m = line.match(WORKSTATION_MISSING_RE))) {
      out.missing_workstation = m[1];
      evidence.push({kind: 'workstation_missing', line, detail: m[1]});
    }
    if (!out.smelt_input_missing && (m = line.match(SMELT_INPUT_RE))) {
      out.smelt_input_missing = m[1];
      evidence.push({kind: 'insufficient_smelt_input', line, detail: m[1]});
    }
    if (!out.fuel_missing && FUEL_MISSING_RE.test(line)) {
      out.fuel_missing = true;
      evidence.push({kind: 'fuel_missing', line, detail: null});
    }
    if (!out.tool_missing_for && (m = line.match(TOOL_MISSING_RE))) {
      out.tool_missing_for = m[1];
      evidence.push({kind: 'tool_missing', line, detail: m[1]});
    }
    if (!out.inventory_full && INVENTORY_FULL_RE.test(line)) {
      out.inventory_full = true;
      evidence.push({kind: 'inventory_full', line, detail: null});
    }
    if (!out.located_at && (m = line.match(FOUND_BLOCK_AT_RE))) {
      const coords = m[1].split(',').map(s => parseFloat(s.trim()));
      out.located_at = {x: coords[0], y: coords[1], z: coords[2]};
    }
    if (out.located_distance == null &&
        (m = line.match(FOUND_ENTITY_DIST_RE))) {
      out.located_distance = parseFloat(m[1]);
    }
    // no_tool is more specific than pathfinder_bail and is the
    // pathfinder-side variant of the skill's "Don't have right tools
    // to harvest X" (TOOL_MISSING_RE). It maps onto the same
    // `tool_missing` root cause so the LLM-facing semantics are
    // identical regardless of which upstream string surfaced it. If
    // an earlier pathfinder_bail entry exists in evidence, the
    // upgrade removes it — same root cause, more precise evidence.
    if ((m = line.match(NO_TOOL_RE)) && out.blocker_kind !== 'no_tool') {
      out.blocker_kind = 'no_tool';
      out.no_tool_for = m[1];
      out.blocker_detail = line;
      const pb_idx = evidence.findIndex(e => e.kind === 'pathfinder_bail');
      if (pb_idx !== -1) evidence.splice(pb_idx, 1);
      if (!evidence.some(e => e.kind === 'tool_missing')) {
        evidence.push({kind: 'tool_missing', line, detail: m[1]});
      }
    } else if (!out.blocker_kind && PATHFINDER_BAIL_RE.test(line)) {
      out.blocker_kind = 'pathfinder_bail';
      out.blocker_detail = line;
      evidence.push({kind: 'pathfinder_bail', line, detail: null});
    }
  }

  // Rank evidence by ROOT_CAUSE_PRIORITY. Stable within a kind (first
  // match within the same kind wins).
  const ranked = ROOT_CAUSE_PRIORITY
                     .map(k => evidence.find(e => e.kind === k))
                     .filter(e => e != null);
  const chosen = ranked[0] ?? null;
  const secondary = ranked[1] ?? null;

  if (chosen) {
    out.root_cause_kind = chosen.kind;
    if (chosen.detail != null) out.root_cause_detail = chosen.detail;
    out.root_cause_line = chosen.line;
    if (secondary) out.secondary_line = secondary.line;
  } else {
    out.root_cause_kind = 'unknown';
    if (out.last_line) out.root_cause_detail = out.last_line;
  }

  return out;
}

// ── Formatting utilities ─────────────────────────────────────────────

function fmt(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '?';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function format_pos(pos) {
  if (pos == null) return null;
  return `(${fmt(pos.x)},${fmt(pos.y)},${fmt(pos.z)})`;
}

// Soft cap on the skill-tail segment. Treated as a guideline, not a
// strict assertion — tests don't fail on overruns. The cap exists so
// long upstream blobs don't dominate the prompt window.
const SKILL_TAIL_CAP = 200;

function format_skill_tail(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > SKILL_TAIL_CAP
      ? trimmed.slice(0, SKILL_TAIL_CAP - 1) + '…'
      : trimmed;
}

// Append the `root_cause=` segment to a command_failure headline,
// formatting kind + structured supplement consistently:
//   workstation_placement_failed at (x,y,z)
//   workstation_missing=furnace
//   insufficient_smelt_input item=raw_iron
//   tool_missing for=stone
//   pathfinder_bail               (diagnostic line goes in skill tail)
//   unknown                       (detail goes in skill tail)
function format_root_cause(kind, detail, parsed) {
  if (!kind) return null;
  if (kind === 'workstation_placement_failed' && parsed?.place_failed_at) {
    return `${kind} at ${format_pos(parsed.place_failed_at)}`;
  }
  if (kind === 'tool_missing' && detail) {
    return `${kind} for=${detail}`;
  }
  if (kind === 'insufficient_smelt_input' && detail) {
    return `${kind} item=${detail}`;
  }
  if (kind === 'workstation_missing' && detail) {
    return `${kind}=${detail}`;
  }
  return kind;
}

// Pick the most informative line for the `| "<tail>"` segment.
//   1. If the chosen root_cause kind already embeds the primary line's
//      data in the headline (e.g. workstation_placement_failed has
//      `at (x,y,z)`), a secondary evidence line carries more
//      non-redundant info. Use it.
//   2. Otherwise prefer the line that established the chosen root_cause
//      (root_cause_line) — it's the diagnostic line by construction.
//   3. Fall back to last_line for the `unknown` case where no evidence
//      matched.
function pick_tail_line(parsed) {
  if (parsed?.root_cause_kind &&
      HEADLINE_EMBEDS_PRIMARY_LINE.has(parsed.root_cause_kind) &&
      parsed.secondary_line) {
    return parsed.secondary_line;
  }
  return parsed?.root_cause_line ?? parsed?.last_line ?? null;
}

// ── Builders ─────────────────────────────────────────────────────────

export function build_command_failure_message({
  command,
  verifier_reason,
  root_cause_kind,
  root_cause_detail,
  skill_output,
  position,
}) {
  // Caller can pass explicit root_cause_kind/detail (the documented
  // contract), or omit them and let the builder derive from
  // skill_output. Either way we parse skill_output once for the
  // last_line + place_failed_at coord (root_cause supplement).
  const parsed = parse_skill_output(skill_output);
  const kind = root_cause_kind ?? parsed.root_cause_kind;
  const detail = root_cause_detail ?? parsed.root_cause_detail;

  const parts = [`cmd=${command}`];
  parts.push(`verifier=${verifier_reason ?? 'n/a'}`);
  const rc = format_root_cause(kind, detail, parsed);
  if (rc) parts.push(`root_cause=${rc}`);
  const pos = format_pos(position);
  if (pos) parts.push(`pos=${pos}`);

  const headline = parts.join('; ');
  // Tail is the most informative diagnostic line, not the
  // last-by-position one. `pick_tail_line` prefers the line that
  // established the chosen root_cause (or a secondary evidence line
  // when the headline already embeds the primary), falling back to
  // last_line only when no evidence was found. This is what keeps a
  // downstream advisory like "Going to the surface at y=102." from
  // hijacking the tail when a real blocker line ("Cannot break stone
  // with current tools.") is present in the same blob.
  const tail = format_skill_tail(pick_tail_line(parsed));
  return tail
      ? `command_failure: ${headline} | "${tail}"`
      : `command_failure: ${headline}`;
}

export function build_command_success_message({command, skill_output}) {
  // Per Step 7: strip known plumbing patterns, hoist success summary to
  // the front, preserve partial-outcome lines (Failed to collect,
  // Don't have right tools, Inventory full, ...). Falls back to the
  // original blob if stripping would empty the message.
  if (typeof skill_output !== 'string' || skill_output.length === 0) {
    return `command_success: cmd=${command}`;
  }
  const body = skill_output.replace(ACTION_OUTPUT_PREFIX, '');
  const lines = body.split('\n').map(s => s.trim()).filter(Boolean);

  const plumbing_patterns = [
    /^Placed crafting_table at /,
    /^Failed to place crafting_table at /,
    /^Collected 1 crafting_table\.?$/,
    /^Placed furnace at /,
    /^Collected 1 furnace\.?$/,
    /^Path not found, but attempting to navigate anyway using destructive movements\.?$/,
  ];
  let kept = lines.filter(l => !plumbing_patterns.some(re => re.test(l)));

  // Strip "Pathfinding stopped: ..." advisory lines that precede a
  // "You have reached at ..." line in the same blob — the skill
  // ultimately reached the goal so those warnings are noise.
  const reached_anywhere = kept.some(l => /^You have reached at /.test(l));
  if (reached_anywhere) {
    kept = kept.filter(l => !/^Pathfinding stopped:/.test(l));
  }

  // Hoist a recognised success summary line to position 0 so the
  // replanner reading top-down sees an unambiguous success first.
  // Scan from the end so the *final* outcome line wins when multiple
  // candidates are present (e.g. for !useOn, "You have reached at"
  // appears mid-blob but "Used bucket on lava" is the true outcome).
  const success_re =
      /^(Successfully crafted|Successfully smelted|Successfully killed|Collected \d+|Used \S+ on |Picked up \d+|Broke \S+ at |You have reached at )/;
  let summary_idx = -1;
  for (let i = kept.length - 1; i >= 0; i--) {
    if (success_re.test(kept[i])) {
      summary_idx = i;
      break;
    }
  }
  if (summary_idx > 0) {
    const [summary] = kept.splice(summary_idx, 1);
    kept.unshift(summary);
  }

  if (kept.length === 0) kept = lines;
  return `command_success: cmd=${command} | ${kept.join(' / ')}`;
}

export function build_mode_interrupted_message({
  command,
  mode_counts,
  position_before,
  position_after,
  mode_reasons,
}) {
  const entries = Object.entries(mode_counts ?? {})
                      .sort((a, b) => b[1] - a[1]);
  const mode_strs = entries.map(([name, n]) => {
    const reason = mode_reasons?.[name];
    if (reason && typeof reason === 'object' && reason.reason) {
      const detail_parts = [`reason=${reason.reason}`];
      for (const [k, v] of Object.entries(reason)) {
        if (k !== 'reason') detail_parts.push(`${k}=${v}`);
      }
      return `${name}×${n} (${detail_parts.join(', ')})`;
    }
    return `${name}×${n}`;
  });
  const modes_str = mode_strs.length > 0 ? mode_strs.join(', ') : 'unknown';

  const parts = [`modes=${modes_str}`];
  parts.push(`cmd=${command}`);
  if (position_before && position_after) {
    const dx = fmt(position_after.x - position_before.x);
    const dy = fmt(position_after.y - position_before.y);
    const dz = fmt(position_after.z - position_before.z);
    parts.push(`bot Δ=(${dx},${dy},${dz})`);
  }
  const pa = format_pos(position_after);
  if (pa) parts.push(`pos_after=${pa}`);
  parts.push('command never completed');

  return `mode_interrupted: ${parts.join('; ')}`;
}

export function build_runner_exception_message({
  command,
  error,
  position,
  stack_top,
}) {
  const name = error?.name ?? error?.constructor?.name ?? 'Error';
  const msg = error?.message ?? String(error);
  const parts = [`${name} "${msg}"`];
  if (stack_top) parts.push(`at ${stack_top}`);
  parts.push(`during cmd=${command}`);
  const pos = format_pos(position);
  if (pos) parts.push(`pos=${pos}`);
  return `runner_exception: ${parts.join('; ')}`;
}

export function build_search_success_message({
  target,
  located_at,
  located_distance,
}) {
  const parts = [`${target} reached`];
  if (located_at) {
    parts.push(`located_at=${format_pos(located_at)}`);
  } else if (typeof located_distance === 'number') {
    parts.push(`distance=${fmt(located_distance)}`);
  }
  return `search_success: ${parts.join(', ')}`;
}

export function build_search_exhausted_message({target, bot_pos, bot_biome}) {
  const parts = [`${target} — no instance within 256 blocks`];
  const pos = format_pos(bot_pos);
  if (pos) parts.push(`bot=${pos}`);
  if (bot_biome) parts.push(`biome=${bot_biome}`);
  return `search_exhausted: ${parts.join('; ')}`;
}

export function build_search_found_not_reached_message({
  target,
  located_at,
  located_distance,
  blocker_kind,
  blocker_detail,
  bot_pos,
}) {
  const parts = [target];
  if (located_at) {
    parts.push(`located_at=${format_pos(located_at)}`);
  } else if (typeof located_distance === 'number') {
    parts.push(`distance=${fmt(located_distance)}`);
  }
  parts.push(`blocker=${blocker_kind ?? 'unknown'}`);
  const pos = format_pos(bot_pos);
  if (pos) parts.push(`bot=${pos}`);

  const headline = parts.join('; ');
  const tail = format_skill_tail(blocker_detail);
  return tail
      ? `search_found_not_reached: ${headline} | "${tail}"`
      : `search_found_not_reached: ${headline}`;
}

export function build_search_already_attempted_message({
  target,
  prior_kind,
  prior_detail,
}) {
  const parts = [target];
  if (prior_kind) parts.push(`prior_kind=${prior_kind}`);
  if (prior_detail) parts.push(`prior_detail="${prior_detail}"`);
  return `search_already_attempted: ${parts.join('; ')}`;
}
