import { readFileSync } from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


/**
 * Fills the ptd_prompt template with an objective string.
 * Returns the filled prompt string, ready to send to an LLM.
 *
 * Example:
 *   const prompt = fill_ptd_prompt('Craft a stone pickaxe');
 */
export function fill_ptd_prompt(objective) {
  const template = _read_template('../../docs/prompts/ptd_prompts/ptd_prompt.md');
  return _fill(template, {OBJECTIVE: objective});
}

/**
 * Fills the ptd_feedback_prompt template with an objective string and a
 * candidate graph object. Returns the filled prompt string.
 *
 * Example:
 *   const prompt = fill_ptd_feedback_prompt('Craft a stone pickaxe',
 * graph_obj);
 */
export function fill_ptd_feedback_prompt(objective, candidate_graph) {
  const template =
      _read_template('../../docs/prompts/ptd_prompts/ptd_feedback_prompt.md');
  return _fill(
      template, {OBJECTIVE: objective, 'CANDIDATE GRAPH': candidate_graph});
}

/**
 * Fills the ptd_refinement_prompt template with an objective string, a
 * candidate graph object, and a validator output object.
 * Returns the filled prompt string.
 *
 * Example:
 *   const prompt = fill_ptd_refinement_prompt('Craft a stone pickaxe',
 * graph_obj, validator_obj);
 */
export function fill_ptd_refinement_prompt(
    objective, candidate_graph, validator_output) {
  const template =
      _read_template('../../docs/prompts/ptd_prompts/ptd_refinement_prompt.md');
  return _fill(template, {
    OBJECTIVE: objective,
    'CANDIDATE GRAPH': candidate_graph,
    'VALIDATOR OUTPUT': validator_output,
  });
}

/**
 * Fills the scsg_prompt template with a graph object and a state object.
 * Returns the filled prompt string.
 *
 * Example:
 *   const prompt = fill_scsg_prompt(graph_obj, state_obj);
 */
export function fill_scsg_prompt(graph, state) {
  const template =
      _read_template('../../docs/prompts/scsg_prompts/scsg_prompt.md');
  return _fill(template, {GRAPH: graph, STATE: state});
}

/**
 * Fills the scsg_feedback_prompt template with a task prompt string and a
 * candidate answer object. The task_prompt is typically the output of
 * fill_scsg_prompt. Returns the filled prompt string.
 *
 * Example:
 *   const task_prompt = fill_scsg_prompt(graph_obj, state_obj);
 *   const prompt = fill_scsg_feedback_prompt(task_prompt,
 * candidate_answer_obj);
 */
export function fill_scsg_feedback_prompt(task_prompt, candidate_answer) {
  const template =
      _read_template('../../docs/prompts/scsg_prompts/scsg_feedback_prompt.md');
  return _fill(template, {
    'FULL TASK PROMPT WITH CONCRETE G AND S': task_prompt,
    'CANDIDATE JSON': candidate_answer,
  });
}

/**
 * Fills the scsg_refiner_prompt template with a task prompt string, a
 * previous candidate object, and an audit report object. The task_prompt
 * is typically the output of fill_scsg_prompt. Returns the filled prompt
 * string.
 *
 * Example:
 *   const task_prompt = fill_scsg_prompt(graph_obj, state_obj);
 *   const prompt = fill_scsg_refiner_prompt(task_prompt,
 * previous_candidate_obj, audit_report_obj);
 */
export function fill_scsg_refiner_prompt(
    task_prompt, previous_candidate, audit_report) {
  const template =
      _read_template('../../docs/prompts/scsg_prompts/scsg_refiner_prompt.md');
  return _fill(template, {
    'FULL TASK PROMPT WITH CONCRETE G AND S': task_prompt,
    'PREVIOUS CANDIDATE JSON': previous_candidate,
    'AUDIT REPORT JSON': audit_report,
  });
}


/* Helper Functions ------------------------------------------------------ */

const _template_cache = new Map();

/**
 * Reads a template file relative to this file's directory.
 * Results are cached after the first read to avoid repeated disk I/O.
 */
function _read_template(relative_path) {
  if (!_template_cache.has(relative_path)) {
    _template_cache.set(relative_path, readFileSync(path.join(__dirname, relative_path), 'utf8'));
  }
  return _template_cache.get(relative_path);
}

/**
 * Replaces {{KEY}} placeholders in a template string with values from inputs.
 * String values are inserted as-is; objects are serialized with JSON.stringify.
 * Warns if a key has no matching placeholder in the template.
 */
function _fill(template, inputs) {
  let result = template;
  for (const [key, value] of Object.entries(inputs)) {
    const serialized = (value !== null && typeof value === 'object') ?
        JSON.stringify(value, null, 2) :
        String(value);
    const filled = result.replaceAll(`{{${key}}}`, serialized);
    if (filled === result) {
      console.warn(`_fill: no placeholder found for key "${key}"`);
    }
    result = filled;
  }
  return result;
}

