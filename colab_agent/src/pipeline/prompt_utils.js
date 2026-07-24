import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fills the assessment_prompt template with the current world state document
 * and the known teammate names. Returns the filled prompt string, ready to
 * send to an LLM.
 */
export function fill_assessment_prompt(doc, teammates) {
  const template = _read_template('../../docs/prompts/disclosure_loop_prompts/assessment_prompt.md');
  return _fill(template, {
    NAME: doc.self.name,
    TEAMMATE_NAMES: teammates.join(', '),
    SHARED_GOAL: doc.shared_goal,
    SELF_STATE: doc.self,
    TEAMMATES_KNOWLEDGE: doc.teammates,
  });
}

/**
 * Fills the ptd_prompt template with the finished Phase 1 world state
 * document and the team's available command vocabulary. Returns the filled
 * prompt string, ready to send to an LLM.
 */
export function fill_ptd_prompt(worldStateDoc, commandDocs) {
  const template = _read_template('../../docs/prompts/ptd_prompts/ptd_prompt.md');
  return _fill(template, {
    OBJECTIVE: worldStateDoc.shared_goal,
    WORLD_STATE: worldStateDoc,
    COMMAND_DOCS: commandDocs,
  });
}

/* Helper functions ------------------------------------------------------ */

const _template_cache = new Map();

// Reads a template file relative to this file's directory. Cached after the
// first read to avoid repeated disk I/O.
function _read_template(relative_path) {
  if (!_template_cache.has(relative_path)) {
    _template_cache.set(
        relative_path,
        readFileSync(path.join(__dirname, relative_path), 'utf8'));
  }
  return _template_cache.get(relative_path);
}

// Replaces {{KEY}} placeholders in a template string with values from
// inputs. String values are inserted as-is; objects are serialized with
// JSON.stringify.
function _fill(template, inputs) {
  let result = template;
  for (const [key, value] of Object.entries(inputs)) {
    const serialized = (value !== null && typeof value === 'object') ?
        JSON.stringify(value, null, 2) :
        String(value);
    result = result.replaceAll(`{{${key}}}`, serialized);
  }
  return result;
}
