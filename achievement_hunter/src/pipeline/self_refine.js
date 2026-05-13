import {extract_json, save_json, to_snake_case} from './json_utils.js';
import {fill_ptd_feedback_prompt, fill_ptd_prompt, fill_ptd_refinement_prompt,} from './prompt_utils.js';

const DEFAULT_OPTIONS = Object.freeze({
  max_rounds: 3,
  save_final_json: true,
  output_dir: 'achievement_hunter/docs/ptd_jsons',
  fail_on_missing_models: false,
});

const STAGES = Object.freeze({
  GENERATE: 'generate',
  VALIDATE: 'validate',
  REFINE: 'refine',
});

const spl = {
  log: (...args) => console.log('[SELF_REFINE]', ...args),
  warn: (...args) => console.warn('[SELF_REFINE]', ...args),
  error: (...args) => console.error('[SELF_REFINE]', ...args),
};

/**
 * Runs a bounded SELF-REFINE loop for PTD generation:
 *   generate -> validate -> refine -> validate -> ... -> accept/fail
 *
 * Expected model interface:
 *   { send_prompt(prompt: string): Promise<string | null> }
 *
 * Preferred model names:
 *   models.ptd
 *   models.ptd_feedback
 *   models.ptd_refinement
 *
 * Accepted aliases:
 *   models.ptd_validator
 *   models.ptd_refine
 */
export async function generate_self_refined_ptd(
    models, task_name, existing_graph = null, log = null, options = {}) {
  const opts = normalize_options(options);

  if (existing_graph) {
    return resume_from_existing_graph(task_name, existing_graph, log);
  }

  const resolved_models =
      resolve_stage_models(models, opts.fail_on_missing_models);
  if (!resolved_models.ok) {
    await safe_log_complete(log, resolved_models.failure_reason);
    return make_failure_result(
        {failure_reason: resolved_models.failure_reason});
  }

  const trace = [];
  const {generator_model, validator_model, refiner_model} = resolved_models;

  spl.log('Building PTD via SELF-REFINE for:', task_name);

  const generation = await run_generation_stage({
    model: generator_model,
    task_name,
    round: 0,
    log,
  });
  trace.push(generation.trace_entry);

  if (!generation.ok) {
    await safe_log_complete(log, generation.failure_reason);
    return make_failure_result({
      failure_reason: generation.failure_reason,
      trace,
      rounds_used: 0,
    });
  }

  let current_graph = generation.graph;
  let last_validator_output = null;

  for (let round = 0; round <= opts.max_rounds; round++) {
    const validation = await run_validation_stage({
      model: validator_model,
      task_name,
      graph: current_graph,
      round,
      log,
    });
    trace.push(validation.trace_entry);

    if (!validation.ok) {
      await safe_log_complete(log, validation.failure_reason);
      return make_failure_result({
        failure_reason: validation.failure_reason,
        trace,
        rounds_used: round,
        validator_output: last_validator_output,
      });
    }

    last_validator_output = validation.validator_output;

    if (validator_passes(validation.validator_output)) {
      persist_final_graph_if_enabled(current_graph, task_name, opts);
      const success_message = `PTD accepted after validation round ${round}`;
      spl.log(success_message);

      return {
        ok: true,
        graph: current_graph,
        validator_output: validation.validator_output,
        rounds_used: round,
        failure_reason: null,
        trace,
      };
    }

    if (round === opts.max_rounds) {
      const failure_reason =
          `PTD failed validation after ${opts.max_rounds} refinement rounds`;
      spl.error(failure_reason);
      await safe_log_complete(log, failure_reason);

      return make_failure_result({
        failure_reason,
        trace,
        rounds_used: round,
        validator_output: validation.validator_output,
      });
    }

    const refinement = await run_refinement_stage({
      model: refiner_model,
      task_name,
      graph: current_graph,
      validator_output: validation.validator_output,
      round: round + 1,
      log,
    });
    trace.push(refinement.trace_entry);

    if (!refinement.ok) {
      await safe_log_complete(log, refinement.failure_reason);
      return make_failure_result({
        failure_reason: refinement.failure_reason,
        trace,
        rounds_used: round + 1,
        validator_output: validation.validator_output,
      });
    }

    current_graph = refinement.graph;
  }

  const failure_reason = 'Unexpected SELF-REFINE termination';
  spl.error(failure_reason);
  await safe_log_complete(log, failure_reason);

  return make_failure_result({
    failure_reason,
    trace,
    rounds_used: opts.max_rounds,
    validator_output: last_validator_output,
  });
}

/**
 * Compatibility wrapper for loop.js-style usage.
 * Returns the accepted graph or null.
 */
export async function generate_primary_task_dag_self_refined(
    models, task_name, existing_graph = null, log = null, options = {}) {
  const result = await generate_self_refined_ptd(
      models, task_name, existing_graph, log, options);
  return result.ok ? result.graph : null;
}

function normalize_options(options) {
  return {...DEFAULT_OPTIONS, ...options};
}

function resume_from_existing_graph(task_name, existing_graph, log) {
  spl.log('Resuming from checkpoint, skipping PTD self-refine for:', task_name);
  safe_log_ptd(log, '[loaded from checkpoint]', existing_graph, {
    source: 'checkpoint',
  });

  return {
    ok: true,
    graph: existing_graph,
    validator_output: null,
    rounds_used: 0,
    failure_reason: null,
    trace: [],
  };
}

function resolve_stage_models(models, fail_on_missing_models) {
  const generator_model = models?.ptd;
  const validator_model =
      models?.ptd_feedback ?? models?.ptd_validator ?? models?.ptd;
  const refiner_model =
      models?.ptd_refinement ?? models?.ptd_refine ?? models?.ptd;

  if (!is_model_like(generator_model)) {
    return {ok: false, failure_reason: 'Missing or invalid models.ptd'};
  }

  if (!is_model_like(validator_model)) {
    return {
      ok: false,
      failure_reason:
          'Missing or invalid PTD validator model (expected models.ptd_feedback, models.ptd_validator, or fallback models.ptd)',
    };
  }

  if (!is_model_like(refiner_model)) {
    return {
      ok: false,
      failure_reason:
          'Missing or invalid PTD refiner model (expected models.ptd_refinement, models.ptd_refine, or fallback models.ptd)',
    };
  }

  if (fail_on_missing_models) {
    if (!is_model_like(models?.ptd_feedback) &&
        !is_model_like(models?.ptd_validator)) {
      return {
        ok: false,
        failure_reason:
            'Missing PTD validator model (expected models.ptd_feedback or models.ptd_validator)',
      };
    }

    if (!is_model_like(models?.ptd_refinement) &&
        !is_model_like(models?.ptd_refine)) {
      return {
        ok: false,
        failure_reason:
            'Missing PTD refiner model (expected models.ptd_refinement or models.ptd_refine)',
      };
    }
  }

  return {
    ok: true,
    generator_model,
    validator_model,
    refiner_model,
  };
}

function is_model_like(model) {
  return !!model && typeof model.send_prompt === 'function';
}

async function run_generation_stage({model, task_name, round, log}) {
  return run_graph_stage({
    model,
    prompt: fill_ptd_prompt(task_name),
    stage: STAGES.GENERATE,
    round,
    log,
    null_response_error: 'PTD model call failed',
    parse_error: 'PTD extraction/shape failed',
  });
}

async function run_validation_stage({model, task_name, graph, round, log}) {
  const result = await run_stage({
    model,
    prompt: fill_ptd_feedback_prompt(task_name, graph),
    stage: STAGES.VALIDATE,
    round,
    log,
    null_response_error: `Validator model call failed at round ${round}`,
    parse_error: `Validator output parse/shape failure at round ${round}`,
    is_valid_shape: is_validator_output_shape,
  });

  if (!result.ok) return result;

  return {
    ...result,
    validator_output: result.parsed,
  };
}

async function run_refinement_stage({
  model,
  task_name,
  graph,
  validator_output,
  round,
  log,
}) {
  return run_graph_stage({
    model,
    prompt: fill_ptd_refinement_prompt(task_name, graph, validator_output),
    stage: STAGES.REFINE,
    round,
    log,
    null_response_error: `Refiner model call failed at round ${round}`,
    parse_error: `Refiner PTD extraction/shape failed at round ${round}`,
  });
}

async function run_graph_stage(config) {
  const result = await run_stage({
    ...config,
    is_valid_shape: is_graph_shape,
  });

  if (!result.ok) return result;

  return {
    ...result,
    graph: result.parsed,
  };
}

async function run_stage({
  model,
  prompt,
  stage,
  round,
  log,
  null_response_error,
  parse_error,
  is_valid_shape,
}) {
  const call = await timed_send_request(model, prompt);
  const parsed = extract_json(call.response);

  const error = call.response === null ?
      null_response_error :
      (is_valid_shape(parsed) ? null : parse_error);

  const trace_entry = {
    stage,
    round,
    latency_ms: call.latency_ms,
    response: call.response,
    parsed,
    error,
  };

  safe_log_ptd(log, call.response ?? '', parsed, {
    latency_ms: call.latency_ms,
    error,
    source: 'llm',
    stage,
    round,
  });

  if (call.response === null) {
    spl.error(null_response_error);
    return {
      ok: false,
      failure_reason: null_response_error,
      trace_entry,
    };
  }

  if (!is_valid_shape(parsed)) {
    spl.error(parse_error);
    return {
      ok: false,
      failure_reason: parse_error,
      trace_entry,
    };
  }

  return {
    ok: true,
    parsed,
    trace_entry,
  };
}

function persist_final_graph_if_enabled(graph, task_name, options) {
  if (!options.save_final_json) return;

  try {
    save_json(graph, `${options.output_dir}/${to_snake_case(task_name)}.json`);
  } catch (error) {
    spl.warn('Failed to save validated PTD JSON:', error);
  }
}

function validator_passes(validator_output) {
  return is_validator_output_shape(validator_output) &&
      validator_output.verdict === 'pass' &&
      validator_output.definite_issues.length === 0;
}

function is_validator_output_shape(value) {
  return !!value && typeof value === 'object' &&
      (value.verdict === 'pass' || value.verdict === 'fail') &&
      Array.isArray(value.definite_issues) &&
      Array.isArray(value.possible_issues) && typeof value.summary === 'string';
}

function is_graph_shape(value) {
  return !!value && typeof value === 'object' &&
      typeof value.objective === 'string' && Array.isArray(value.sinks) &&
      Array.isArray(value.vertices) && Array.isArray(value.edges) &&
      value.vertices.every(is_vertex_shape) && value.edges.every(is_edge_shape);
}

function is_vertex_shape(vertex) {
  return !!vertex && typeof vertex === 'object' &&
      typeof vertex.id === 'string' && Number.isInteger(vertex.qty) &&
      typeof vertex.item_type === 'string' &&
      typeof vertex.acquisition_dependency === 'string';
}

function is_edge_shape(edge) {
  return !!edge && typeof edge === 'object' && typeof edge.from === 'string' &&
      typeof edge.to === 'string' && typeof edge.type === 'string' &&
      Number.isInteger(edge.qty) && typeof edge.consumed === 'boolean';
}

async function timed_send_request(model, prompt) {
  const started_ms = Date.now();

  try {
    return {
      response: await model.send_prompt(prompt),
      latency_ms: Date.now() - started_ms,
    };
  } catch (error) {
    spl.error('Model request threw:', error);
    return {
      response: null,
      latency_ms: Date.now() - started_ms,
    };
  }
}

function safe_log_ptd(log, raw, parsed, meta) {
  try {
    if (log && typeof log.ptd === 'function') {
      log.ptd(raw, parsed, meta);
    }
  } catch (error) {
    spl.warn('log.ptd failed:', error);
  }
}

async function safe_log_complete(log, reason) {
  try {
    if (log && typeof log.complete === 'function') {
      await log.complete(reason);
    }
  } catch (error) {
    spl.warn('log.complete failed:', error);
  }
}

function make_failure_result({
  failure_reason,
  trace = [],
  rounds_used = 0,
  validator_output = null,
}) {
  return {
    ok: false,
    graph: null,
    validator_output,
    rounds_used,
    failure_reason,
    trace,
  };
}