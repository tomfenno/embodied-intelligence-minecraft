import { mkdirSync, writeFileSync } from 'fs';
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
    if (str[i] === openChar) depth++;
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
 * Extracts the first JSON object from an LLM response string and writes
 * it to file_path. Creates parent directories if they don't exist.
 * Returns the parsed object, or null if no valid JSON is found.
 *
 * Example:
 *   const obj = save_json(llm_output, 'achievement_hunter/logs/output.json');
 *   // obj => { ... } or null if extraction failed
 */
export function save_json(str, file_path) {
  const obj = extract_json(str);
  if (obj === null) {
    console.warn('save_json: no valid JSON found in LLM response.');
    return null;
  }
  mkdirSync(path.dirname(file_path), { recursive: true });
  writeFileSync(file_path, JSON.stringify(obj, null, 4), 'utf8');
  return obj;
}
