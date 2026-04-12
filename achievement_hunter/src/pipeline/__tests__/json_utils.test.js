/**
 * Baseline tests for extract_json and save_json.
 * Imports from prompt_utils.js (current location).
 * After Phase 3a these will be moved to json_utils.js and the import updated.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import os from 'os';
import path from 'path';

import { extract_json, save_json } from '../json_utils.js';

// ── extract_json ────────────────────────────────────────────────────────────

describe('extract_json', () => {
  it('parses a plain JSON object', () => {
    expect(extract_json('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses JSON with leading prose text', () => {
    expect(extract_json('Here is the result: {"a":1} done.')).toEqual({ a: 1 });
  });

  it('strips ```json code fences', () => {
    expect(extract_json('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('strips plain ``` code fences', () => {
    expect(extract_json('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses a JSON array', () => {
    expect(extract_json('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('returns null when there is no JSON', () => {
    expect(extract_json('no json here')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(extract_json('{"a":}')).toBeNull();
  });

  it('handles deeply nested objects', () => {
    expect(extract_json('{"a":{"b":{"c":3}}}')).toEqual({ a: { b: { c: 3 } } });
  });

  it('ignores text after the closing brace', () => {
    expect(extract_json('{"a":1} extra text')).toEqual({ a: 1 });
  });

  it('parses verdict:"pass" with no spaces (current passing case)', () => {
    expect(extract_json('{"verdict":"pass"}')).toEqual({ verdict: 'pass' });
  });

  it('parses verdict: "pass" with one space after colon (current passing case)', () => {
    expect(extract_json('{"verdict": "pass"}')).toEqual({ verdict: 'pass' });
  });

  it('parses TASK_COMPLETE status signal', () => {
    expect(extract_json('{"status":"TASK_COMPLETE"}')).toEqual({ status: 'TASK_COMPLETE' });
  });

  it('parses r=2 completion signal', () => {
    expect(extract_json('{"r":2,"s":[],"final":{}}')).toMatchObject({ r: 2 });
  });
});

// ── save_json ───────────────────────────────────────────────────────────────

describe('save_json', () => {
  it('writes the extracted JSON to disk and returns the parsed object', () => {
    const tmp = path.join(os.tmpdir(), `test_save_json_${Date.now()}.json`);
    try {
      const result = save_json('{"x":42}', tmp);
      expect(result).toEqual({ x: 42 });
      expect(existsSync(tmp)).toBe(true);
      expect(JSON.parse(readFileSync(tmp, 'utf8'))).toEqual({ x: 42 });
    } finally {
      if (existsSync(tmp)) unlinkSync(tmp);
    }
  });

  it('returns null and does not write a file when no valid JSON is found', () => {
    const tmp = path.join(os.tmpdir(), `test_save_json_null_${Date.now()}.json`);
    const result = save_json('no json here', tmp);
    expect(result).toBeNull();
    expect(existsSync(tmp)).toBe(false);
  });

  it('creates parent directories if they do not exist', () => {
    const tmp = path.join(os.tmpdir(), `vitest_nested_${Date.now()}`, 'deep', 'out.json');
    try {
      const result = save_json('{"nested":true}', tmp);
      expect(result).toEqual({ nested: true });
      expect(existsSync(tmp)).toBe(true);
    } finally {
      if (existsSync(tmp)) unlinkSync(tmp);
    }
  });
});
