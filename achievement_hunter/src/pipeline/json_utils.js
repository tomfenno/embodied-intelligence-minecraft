import {mkdirSync, writeFileSync} from 'fs';
import path from 'path';

/**
 * Extracts the first JSON object or array from an LLM response string.
 * Handles extra text before/after the JSON and markdown code fences.
 * Returns the parsed object, or null if no valid JSON is found.
 *
 * Example:
 *   const obj = extract_json('Here is the result: {"a": 1} done.');
 *   // obj => { a: 1 }
 *
 *   const obj = extract_json('```json\n{"a": 1}\n```');
 *   // obj => { a: 1 }
 */
/**
 * Strips markdown code fences from a string and returns the trimmed inner
 * content. If no fences are present, returns the string trimmed as-is.
 *
 * Example:
 *   strip_fences('```plaintext\n!collectBlocks("oak_log", 3)\n```')
 *   // => '!collectBlocks("oak_log", 3)'
 */
export function strip_fences(str) {
  if (typeof str !== 'string') return str;
  const fenced = str.match(/```(?:\w+)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : str.trim();
}

export function extract_json(str) {
  // strip markdown code fences if present
  const fenced = str.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) str = fenced[1];

  // find start of outermost { } or [ ]
  const start = str.search(/[{[]/);
  if (start === -1) return null;

  const openChar = str[start];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let end = -1;

  for (let i = start; i < str.length; i++) {
    if (str[i] === openChar)
      depth++;
    else if (str[i] === closeChar) {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end === -1) return null;

  try {
    return JSON.parse(str.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Writes a JSON object to file_path.
 * Creates parent directories if they don't exist.
 * Returns the same object, or null if the input is invalid.
 *
 * Example:
 *   const obj = extract_json(llm_output);
 *   save_json(obj, 'achievement_hunter/logs/output.json');
 */
export function save_json(obj, file_path) {
  if (obj === null || obj === undefined) {
    console.warn('save_json: no valid JSON object provided.');
    return null;
  }

  mkdirSync(path.dirname(file_path), {recursive: true});
  writeFileSync(file_path, JSON.stringify(obj, null, 4), 'utf8');
  return obj;
}

/**
 * Converts a string like "Smelt an iron ingot" into snake_case
 * for use in file names.
 *
 * Example:
 *   to_snake_case("Smelt an iron ingot");
 *   // => "smelt_an_iron_ingot"
 */
export function to_snake_case(str) {
  return str.trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
}
