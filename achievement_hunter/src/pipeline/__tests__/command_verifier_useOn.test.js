import {describe, expect, it} from 'vitest';

import {verify_command_outcome} from '../command_verifier.js';

describe('!useOn verifier', () => {
  it('reclassifies silent-success bucket fill (no lava_bucket delta)', () => {
    const pre = {inventory: {bucket: 1}};
    const post = {inventory: {bucket: 1}};
    const result =
        verify_command_outcome('!useOn("bucket", "lava")', pre, post, null);
    expect(result).toEqual({
      verified: true,
      ok: false,
      reason: 'bucket_unfilled',
    });
  });

  it('passes real bucket fill (lava_bucket appears)', () => {
    const pre = {inventory: {bucket: 1}};
    const post = {inventory: {lava_bucket: 1}};
    const result =
        verify_command_outcome('!useOn("bucket", "lava")', pre, post, null);
    expect(result.verified).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('lava_bucket_delta=1');
  });

  it('passes real water bucket fill', () => {
    const pre = {inventory: {bucket: 1}};
    const post = {inventory: {water_bucket: 1}};
    const result =
        verify_command_outcome('!useOn("bucket", "water")', pre, post, null);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('water_bucket_delta=1');
  });

  it('reclassifies silent-success water bucket fill', () => {
    const pre = {inventory: {bucket: 2}};
    const post = {inventory: {bucket: 2}};
    const result =
        verify_command_outcome('!useOn("bucket", "water")', pre, post, null);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bucket_unfilled');
  });

  it('passes through non-bucket tools (shears on sheep)', () => {
    const pre = {inventory: {shears: 1}};
    const post = {inventory: {shears: 1}};
    const result =
        verify_command_outcome('!useOn("shears", "sheep")', pre, post, null);
    expect(result.verified).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('non_bucket_tool');
  });

  it('passes through unmapped targets (bucket on "nothing")', () => {
    const pre = {inventory: {bucket: 1}};
    const post = {inventory: {bucket: 1}};
    const result =
        verify_command_outcome('!useOn("bucket", "nothing")', pre, post, null);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('unknown_useOn_target:nothing');
  });

  it('normalizes target case (LAVA → lava)', () => {
    const pre = {inventory: {bucket: 1}};
    const post = {inventory: {lava_bucket: 1}};
    const result =
        verify_command_outcome('!useOn("bucket", "LAVA")', pre, post, null);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('lava_bucket_delta=1');
  });

  it('verifies cow milking via milk_bucket delta', () => {
    const pre = {inventory: {bucket: 1}};
    const post = {inventory: {milk_bucket: 1}};
    const result =
        verify_command_outcome('!useOn("bucket", "cow")', pre, post, null);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('milk_bucket_delta=1');
  });

  it('reclassifies failed cow milking', () => {
    const pre = {inventory: {bucket: 1}};
    const post = {inventory: {bucket: 1}};
    const result =
        verify_command_outcome('!useOn("bucket", "cow")', pre, post, null);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bucket_unfilled');
  });

  it('verifies obsidian creation (water_bucket on lava, obsidian present)', () => {
    // The bucket empties whether or not obsidian formed, so success is
    // checked by the obsidian block appearing in nearby world state, not
    // by an inventory delta.
    const pre = {inventory: {water_bucket: 1}, nearby_blocks: ['lava', 'stone']};
    const post = {
      inventory: {bucket: 1},
      nearby_blocks: ['obsidian', 'stone'],
    };
    const result =
        verify_command_outcome('!useOn("water_bucket", "lava")', pre, post, null);
    expect(result.verified).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('obsidian_present');
  });

  it('reclassifies failed obsidian creation (no obsidian in state)', () => {
    const pre = {inventory: {water_bucket: 1}, nearby_blocks: ['lava', 'stone']};
    const post = {inventory: {bucket: 1}, nearby_blocks: ['lava', 'stone']};
    const result =
        verify_command_outcome('!useOn("water_bucket", "lava")', pre, post, null);
    expect(result.verified).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_obsidian');
  });

  it('unparseable args pass through as ok', () => {
    // Bare identifiers — JSON.parse fails in extract_command_args, so the
    // verifier never runs and the wrapper returns unparseable_args.
    const result =
        verify_command_outcome('!useOn(bucket, lava)', {}, {}, null);
    expect(result.verified).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('unparseable_args');
  });
});
