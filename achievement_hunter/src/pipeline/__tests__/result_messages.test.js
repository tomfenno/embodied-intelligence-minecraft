import {describe, expect, it} from 'vitest';

import {
  build_command_failure_message,
  build_command_success_message,
  build_mode_interrupted_message,
  build_runner_exception_message,
  build_search_already_attempted_message,
  build_search_exhausted_message,
  build_search_found_not_reached_message,
  build_search_success_message,
  parse_skill_output,
} from '../structured_loop/result_messages.js';

// Fixtures are inline (and trimmed to one trailing newline like the
// upstream skill log helper emits) so the regression target is obvious
// at the point of failure. Captured from real runs in
// achievement_hunter/evaluation_harness/experiments/achievement_hunter_eval_v2_full
// where indicated.

// ── parse_skill_output ──────────────────────────────────────────────

describe('parse_skill_output', () => {
  it('returns unknown root_cause and null last_line for empty input', () => {
    expect(parse_skill_output('')).toEqual({
      last_line: null,
      root_cause_kind: 'unknown',
    });
    expect(parse_skill_output(null)).toEqual({
      last_line: null,
      root_cause_kind: 'unknown',
    });
  });

  it('strips Action output: prefix and trims/last_line', () => {
    const blob =
        'Action output:\nSuccessfully crafted oak_planks, you now have 8 oak_planks.\n';
    const out = parse_skill_output(blob);
    expect(out.last_line).toBe(
        'Successfully crafted oak_planks, you now have 8 oak_planks.');
    expect(out.root_cause_kind).toBe('unknown');
  });

  it('detects workstation_placement_failed with coords (acquire_hardware run)', () => {
    // From acquire_hardware/runner_stdout.log:143-149
    const blob = 'Action output:\nFailed to place furnace at (104, 130, -24).\n' +
        'There is no furnace nearby and you have no furnace.\n';
    const out = parse_skill_output(blob);
    expect(out.place_failed_at)
        .toEqual({workstation: 'furnace', x: 104, y: 130, z: -24});
    expect(out.missing_workstation).toBe('furnace');
    // First match in the priority order wins.
    expect(out.root_cause_kind).toBe('workstation_placement_failed');
  });

  it('detects workstation_missing without prior place-failure', () => {
    const blob =
        'Action output:\nThere is no furnace nearby and you have no furnace.\n';
    const out = parse_skill_output(blob);
    expect(out.missing_workstation).toBe('furnace');
    expect(out.root_cause_kind).toBe('workstation_missing');
    expect(out.root_cause_detail).toBe('furnace');
  });

  it('detects insufficient_smelt_input', () => {
    const blob = 'Action output:\nYou do not have enough raw_iron to smelt.\n';
    const out = parse_skill_output(blob);
    expect(out.smelt_input_missing).toBe('raw_iron');
    expect(out.root_cause_kind).toBe('insufficient_smelt_input');
  });

  it('detects fuel_missing', () => {
    const blob = 'Action output:\nYou have no fuel to smelt raw_iron, you need coal, charcoal, or wood.\n';
    const out = parse_skill_output(blob);
    expect(out.fuel_missing).toBe(true);
    expect(out.root_cause_kind).toBe('fuel_missing');
  });

  it('detects tool_missing', () => {
    const blob = "Action output:\nDon't have right tools to harvest stone.\n";
    const out = parse_skill_output(blob);
    expect(out.tool_missing_for).toBe('stone');
    expect(out.root_cause_kind).toBe('tool_missing');
  });

  it('detects inventory_full', () => {
    const blob = 'Action output:\nFailed to collect oak_log: Inventory full, no place to deposit.\n';
    const out = parse_skill_output(blob);
    expect(out.inventory_full).toBe(true);
    expect(out.root_cause_kind).toBe('inventory_full');
  });

  it('extracts located_at coords from block-search output (hot_stuff run)', () => {
    // From hot_stuff/runner_stdout.log:202-209
    const blob = 'Action output:\nFound lava at (124, 69, -37). Navigating...\n' +
        'Path not found, but attempting to navigate anyway using destructive movements.\n' +
        'Pathfinding stopped: Cannot break stone with current tools.\n' +
        'Pathfinding stopped: Path was stopped before it could be completed!\n';
    const out = parse_skill_output(blob);
    expect(out.located_at).toEqual({x: 124, y: 69, z: -37});
    expect(out.blocker_kind).toBe('no_tool');
    expect(out.no_tool_for).toBe('stone');
    expect(out.blocker_detail)
        .toBe('Pathfinding stopped: Cannot break stone with current tools.');
  });

  it('extracts located_distance from entity-search output (pork_chop run)', () => {
    // From pork_chop/runner_stdout.log:158-167
    const blob = 'Action output:\nFound pig 141.4270195391474 blocks away.\n' +
        'Path not found, but attempting to navigate anyway using destructive movements.\n' +
        'Pathfinding stopped: Cannot break stone with current tools.\n';
    const out = parse_skill_output(blob);
    expect(out.located_distance).toBeCloseTo(141.4270195391474);
    expect(out.located_at).toBeUndefined();
    expect(out.blocker_kind).toBe('no_tool');
  });

  it('classifies bare pathfinder bail as pathfinder_bail (no Cannot-break line)', () => {
    const blob = 'Action output:\nPath not found.\nPathfinding stopped: Path was stopped before it could be completed.\n';
    const out = parse_skill_output(blob);
    expect(out.blocker_kind).toBe('pathfinder_bail');
  });

  it('degrades to unknown + last_line on unrecognised content', () => {
    const blob = 'Action output:\nSome novel skill warning we have never seen.\n';
    const out = parse_skill_output(blob);
    expect(out.root_cause_kind).toBe('unknown');
    expect(out.root_cause_detail)
        .toBe('Some novel skill warning we have never seen.');
    expect(out.last_line)
        .toBe('Some novel skill warning we have never seen.');
  });
});

// ── build_command_failure_message ───────────────────────────────────

describe('build_command_failure_message', () => {
  it('formats verifier reclassification with workstation_placement_failed', () => {
    const skill_output =
        'Action output:\nFailed to place furnace at (104, 130, -24).\n' +
        'There is no furnace nearby and you have no furnace.\n';
    const msg = build_command_failure_message({
      command: '!smelt_item("raw_iron",1,"oak_planks")',
      verifier_reason: 'no_iron_ingot_delta',
      skill_output,
      position: {x: 108, y: 130, z: -25},
    });
    expect(msg).toBe(
        'command_failure: cmd=!smelt_item("raw_iron",1,"oak_planks"); ' +
        'verifier=no_iron_ingot_delta; ' +
        'root_cause=workstation_placement_failed at (104,130,-24); ' +
        'pos=(108,130,-25) | ' +
        '"There is no furnace nearby and you have no furnace."');
  });

  it('emits root_cause=unknown with skill tail for unrecognised failures', () => {
    const msg = build_command_failure_message({
      command: '!unknown("x")',
      verifier_reason: null,
      skill_output: 'Action output:\nSome novel cause.\n',
      position: null,
    });
    expect(msg).toBe(
        'command_failure: cmd=!unknown("x"); verifier=n/a; root_cause=unknown | "Some novel cause."');
  });

  it('accepts explicit root_cause_kind override', () => {
    const msg = build_command_failure_message({
      command: '!collectBlocks("stone",11)',
      verifier_reason: 'no_inventory_delta',
      root_cause_kind: 'tool_missing',
      root_cause_detail: 'stone',
      skill_output: "Action output:\nDon't have right tools to harvest stone.\n",
      position: {x: 0, y: 64, z: 0},
    });
    expect(msg).toContain('root_cause=tool_missing for=stone');
    expect(msg).toContain('verifier=no_inventory_delta');
  });

  it('handles missing skill_output gracefully', () => {
    const msg = build_command_failure_message({
      command: '!foo()',
      verifier_reason: 'some_reason',
      skill_output: null,
      position: null,
    });
    // Falls through to root_cause=unknown but no tail (unknown + no last_line).
    expect(msg).toBe(
        'command_failure: cmd=!foo(); verifier=some_reason; root_cause=unknown');
  });

  // Regression: pork_chops run, runner_stdout.log:540-546. Previously
  // emitted root_cause=unknown with "Going to the surface at y=102." as
  // tail despite the same blob containing "Cannot break stone with
  // current tools.". See docs/messages/command-failure-loses-real-blocker.md.
  it('promotes pathfinder-side no_tool to root_cause=tool_missing and picks the blocker line as tail', () => {
    const skill_output = 'Action output:\n' +
        'Path not found, but attempting to navigate anyway using destructive movements.\n' +
        'Pathfinding stopped: Cannot break stone with current tools.\n' +
        'Pathfinding stopped: Path was stopped before it could be completed! ' +
        'Thus, the desired goal was not reached..\n' +
        'Going to the surface at y=102.\n';
    const msg = build_command_failure_message({
      command: '!goToSurface()',
      verifier_reason: null,
      skill_output,
      position: {x: -5.5, y: 87, z: 184.5},
    });
    // Headline names the cause with the block; tail is the diagnostic
    // line, not the trailing "Going to the surface..." advisory.
    expect(msg).toBe(
        'command_failure: cmd=!goToSurface(); verifier=n/a; ' +
        'root_cause=tool_missing for=stone; pos=(-5.5,87,184.5) | ' +
        '"Pathfinding stopped: Cannot break stone with current tools."');
    expect(msg).not.toContain('Going to the surface');
    expect(msg).not.toContain('root_cause=unknown');
  });

  // Regression: pork_chops run, runner_stdout.log:577-582. Same blocker
  // pattern, different command, blocker line is in the middle of the
  // blob rather than at the end.
  it('picks blocker line as tail even when downstream pathfinder warnings come after it', () => {
    const skill_output = 'Action output:\n' +
        'Path not found, but attempting to navigate anyway using destructive movements.\n' +
        'Pathfinding stopped: Cannot break stone with current tools.\n' +
        'Pathfinding stopped: Path was stopped before it could be completed! ' +
        'Thus, the desired goal was not reached..\n';
    const msg = build_command_failure_message({
      command: '!goToXZ(-5, 430, 8)',
      verifier_reason: null,
      skill_output,
      position: {x: -5.5, y: 87, z: 184.5},
    });
    expect(msg).toContain('root_cause=tool_missing for=stone');
    // Tail is the specific diagnostic, NOT the generic "Path was stopped" wrap-up.
    expect(msg).toContain(
        '| "Pathfinding stopped: Cannot break stone with current tools."');
    expect(msg).not.toContain('"Pathfinding stopped: Path was stopped');
  });

  // Surfaces a generic pathfinder bail (no specific blocker recognized)
  // as root_cause=pathfinder_bail rather than unknown — the LLM gets
  // "routing failure" vs. "we have no diagnosis".
  it('promotes bare pathfinder_bail to root_cause=pathfinder_bail with the bail line as tail', () => {
    const skill_output = 'Action output:\n' +
        'Path not found.\n' +
        'Pathfinding stopped: Path was stopped before it could be completed..\n';
    const msg = build_command_failure_message({
      command: '!goToCoordinates(100, 70, -200, 1)',
      verifier_reason: null,
      skill_output,
      position: {x: 0, y: 70, z: 0},
    });
    expect(msg).toContain('root_cause=pathfinder_bail');
    expect(msg).toContain('| "Path not found."');
    expect(msg).not.toContain('root_cause=unknown');
  });

  // Locks in the existing "secondary_line as tail" behavior for
  // workstation_placement_failed: the headline embeds the placement
  // coords from the primary line, so the tail uses a different
  // diagnostic line (the workstation_missing entry).
  it('uses secondary_line as tail when the headline already embeds the primary line data', () => {
    const skill_output =
        'Action output:\nFailed to place furnace at (104, 130, -24).\n' +
        'There is no furnace nearby and you have no furnace.\n';
    const msg = build_command_failure_message({
      command: '!smelt_item("raw_iron",1,"oak_planks")',
      verifier_reason: 'no_iron_ingot_delta',
      skill_output,
      position: {x: 108, y: 130, z: -25},
    });
    // Headline carries the placement coords; tail carries the "no furnace
    // nearby" secondary diagnostic (a distinct fact, not a redundant echo).
    expect(msg).toBe(
        'command_failure: cmd=!smelt_item("raw_iron",1,"oak_planks"); ' +
        'verifier=no_iron_ingot_delta; ' +
        'root_cause=workstation_placement_failed at (104,130,-24); ' +
        'pos=(108,130,-25) | ' +
        '"There is no furnace nearby and you have no furnace."');
  });
});

// ── build_command_success_message ───────────────────────────────────

describe('build_command_success_message', () => {
  it('strips crafting_table place/pickup plumbing and hoists the success line', () => {
    // From moar_tools/runner_stdout.log:111-117
    const skill_output =
        'Action output:\nFailed to place crafting_table at (106, 137, -26).\n' +
        'Successfully crafted wooden_axe, you now have 1 wooden_axe.\n' +
        'Collected 1 crafting_table.\n';
    const msg = build_command_success_message({
      command: '!craftRecipe("wooden_axe", 1)',
      skill_output,
    });
    expect(msg).toBe(
        'command_success: cmd=!craftRecipe("wooden_axe", 1) | ' +
        'Successfully crafted wooden_axe, you now have 1 wooden_axe.');
  });

  it('preserves "Failed to collect X" partial-outcome line', () => {
    // From acquire_hardware/runner_stdout.log:34-39
    const skill_output =
        'Action output:\nFailed to collect oak_log: Timeout: Took to long to decide path to goal!.\n' +
        'Collected 4 oak_log.\n';
    const msg = build_command_success_message({
      command: '!collectBlocks("oak_log", 5)',
      skill_output,
    });
    expect(msg).toContain('Collected 4 oak_log.');
    expect(msg).toContain('Failed to collect oak_log');
    // Success line hoisted to the front.
    const body = msg.split(' | ')[1];
    expect(body.startsWith('Collected 4 oak_log.')).toBe(true);
  });

  it('strips destructive-navigation advisory and reached-pathfinding noise', () => {
    // From hot_stuff/runner_stdout.log:219-227 (the lava bucket-fill success)
    const skill_output = 'Action output:\n' +
        'Path not found, but attempting to navigate anyway using destructive movements.\n' +
        'You have reached at 124, 69, -37.\n' +
        'Breaking dirt to reach lava...\n' +
        'Equipped bucket.\n' +
        'Used bucket on lava.\n';
    const msg = build_command_success_message({
      command: '!useOn("bucket", "lava")',
      skill_output,
    });
    expect(msg).not.toContain('Path not found');
    expect(msg).not.toContain('Pathfinding stopped');
    // Used <X> on <Y> is recognised as a success summary; hoisted.
    const body = msg.split(' | ')[1];
    expect(body.startsWith('Used bucket on lava.')).toBe(true);
  });

  it('falls back to original blob if stripping would empty the message', () => {
    const skill_output = 'Action output:\nPlaced crafting_table at (1, 2, 3).\n';
    const msg = build_command_success_message({
      command: '!placeHere("crafting_table")',
      skill_output,
    });
    expect(msg).toContain('Placed crafting_table at (1, 2, 3).');
  });

  it('handles empty skill output', () => {
    expect(build_command_success_message({command: '!foo()', skill_output: ''}))
        .toBe('command_success: cmd=!foo()');
    expect(build_command_success_message({command: '!foo()', skill_output: null}))
        .toBe('command_success: cmd=!foo()');
  });
});

// ── build_mode_interrupted_message ──────────────────────────────────

describe('build_mode_interrupted_message', () => {
  it('formats basic mode counts + displacement + pos_after', () => {
    const msg = build_mode_interrupted_message({
      command: '!collectBlocks("stone", 11)',
      mode_counts: {unstuck: 5},
      position_before: {x: 100, y: 70, z: 200},
      position_after: {x: 105.2, y: 73, z: 198.5},
    });
    expect(msg).toBe(
        'mode_interrupted: modes=unstuck×5; ' +
        'cmd=!collectBlocks("stone", 11); ' +
        'bot Δ=(5.2,3,-1.5); ' +
        'pos_after=(105.2,73,198.5); ' +
        'command never completed');
  });

  it('sorts multiple modes by count descending', () => {
    const msg = build_mode_interrupted_message({
      command: '!goToCoordinates(0, 70, 0, 1)',
      mode_counts: {unstuck: 5, self_preservation: 2},
      position_before: {x: 0, y: 70, z: 0},
      position_after: {x: 0, y: 70, z: 0},
    });
    expect(msg).toContain('modes=unstuck×5, self_preservation×2');
  });

  it('forward-compatible: includes reason segments when mode_reasons provided', () => {
    const msg = build_mode_interrupted_message({
      command: '!collectBlocks("stone", 11)',
      mode_counts: {unstuck: 5},
      position_before: {x: 0, y: 70, z: 0},
      position_after: {x: 1, y: 70, z: 0},
      mode_reasons: {unstuck: {reason: 'stuck', dig: 'stone'}},
    });
    expect(msg).toContain('modes=unstuck×5 (reason=stuck, dig=stone)');
  });

  it('degrades to "unknown" when no modes are reported', () => {
    const msg = build_mode_interrupted_message({
      command: '!foo()',
      mode_counts: {},
      position_before: null,
      position_after: null,
    });
    expect(msg).toContain('modes=unknown');
    expect(msg).toContain('command never completed');
  });
});

// ── build_runner_exception_message ──────────────────────────────────

describe('build_runner_exception_message', () => {
  it('captures error name, message, stack tail, command, position', () => {
    const err = new TypeError("Cannot read properties of undefined (reading 'x')");
    const stack_top = 'world.js:142 / agent.js:88';
    const msg = build_runner_exception_message({
      command: '!collectBlocks("oak_log", 5)',
      error: err,
      position: {x: 108, y: 128, z: -19},
      stack_top,
    });
    expect(msg).toBe(
        'runner_exception: TypeError "Cannot read properties of undefined ' +
        "(reading 'x')\"; at world.js:142 / agent.js:88; " +
        'during cmd=!collectBlocks("oak_log", 5); ' +
        'pos=(108,128,-19)');
  });

  it('handles string errors and missing stack', () => {
    const msg = build_runner_exception_message({
      command: '!foo()',
      error: new Error('something broke'),
      position: null,
    });
    expect(msg).toContain('Error "something broke"');
    expect(msg).not.toContain('at undefined');
  });
});

// ── search_* builders ───────────────────────────────────────────────

describe('build_search_success_message', () => {
  it('formats located_at coords', () => {
    expect(build_search_success_message(
               {target: 'lava', located_at: {x: 124, y: 69, z: -37}}))
        .toBe('search_success: lava reached, located_at=(124,69,-37)');
  });

  it('formats located_distance for entities', () => {
    expect(build_search_success_message(
               {target: 'pig', located_distance: 14.5}))
        .toBe('search_success: pig reached, distance=14.5');
  });

  it('omits position when neither is provided', () => {
    expect(build_search_success_message({target: 'cow'}))
        .toBe('search_success: cow reached');
  });
});

describe('build_search_exhausted_message', () => {
  it('formats target, bot position, biome', () => {
    expect(build_search_exhausted_message({
      target: 'lava',
      bot_pos: {x: 108, y: 128, z: -19},
      bot_biome: 'lush_caves',
    }))
        .toBe(
            'search_exhausted: lava — no instance within 256 blocks; ' +
            'bot=(108,128,-19); biome=lush_caves');
  });

  it('degrades gracefully when bot_pos / biome are absent', () => {
    expect(build_search_exhausted_message({target: 'pig'}))
        .toBe('search_exhausted: pig — no instance within 256 blocks');
  });
});

describe('build_search_found_not_reached_message', () => {
  it('formats block-search case with coords + no_tool blocker', () => {
    const msg = build_search_found_not_reached_message({
      target: 'lava',
      located_at: {x: 124, y: 69, z: -37},
      blocker_kind: 'no_tool',
      blocker_detail: 'Pathfinding stopped: Cannot break stone with current tools.',
      bot_pos: {x: 108, y: 128, z: -19},
    });
    expect(msg).toBe(
        'search_found_not_reached: lava; located_at=(124,69,-37); ' +
        'blocker=no_tool; bot=(108,128,-19) | "Pathfinding stopped: ' +
        'Cannot break stone with current tools."');
  });

  it('formats entity-search case with distance only', () => {
    const msg = build_search_found_not_reached_message({
      target: 'pig',
      located_distance: 141.4,
      blocker_kind: 'no_tool',
      blocker_detail: 'Cannot break stone with current tools',
      bot_pos: {x: 105, y: 130, z: -25},
    });
    expect(msg).toContain('distance=141.4');
    expect(msg).not.toContain('located_at');
    expect(msg).toContain('blocker=no_tool');
  });

  it('uses blocker=unknown when blocker_kind is absent', () => {
    const msg = build_search_found_not_reached_message({
      target: 'pig',
      located_distance: 50,
      bot_pos: {x: 0, y: 70, z: 0},
    });
    expect(msg).toContain('blocker=unknown');
  });
});

describe('build_search_already_attempted_message', () => {
  it('includes prior_kind and prior_detail', () => {
    expect(build_search_already_attempted_message({
      target: 'pig',
      prior_kind: 'search_found_not_reached',
      prior_detail: 'located_at=(224,125,-98); blocker=no_tool',
    }))
        .toBe(
            'search_already_attempted: pig; ' +
            'prior_kind=search_found_not_reached; ' +
            'prior_detail="located_at=(224,125,-98); blocker=no_tool"');
  });

  it('degrades to bare target when no prior outcome is known', () => {
    expect(build_search_already_attempted_message({target: 'pig'}))
        .toBe('search_already_attempted: pig');
  });
});
