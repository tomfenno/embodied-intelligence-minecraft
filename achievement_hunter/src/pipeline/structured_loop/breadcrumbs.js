import {
  getBiomeName,
  getNearbyEntities,
  getNearestBlocks,
  getPosition,
} from '../../../../src/agent/library/world.js';

import {make_spl} from './log.js';

// Flowing water/lava share names with their source blocks; metadata 0 is a
// source, metadata 1-7 is flowing. We only want source liquids as map features.
const COLLECTIBLE_LIQUIDS = new Set(['water', 'lava']);

// spatial_isolation is normalized to BREADCRUMB_MIN_DIST units; capping
// prevents a single faraway outlier from dominating the score.
const SPATIAL_ISOLATION_CAP = 8;

const spl = make_spl('[SPL][breadcrumbs]');

/**
 * Maintains a spatial map of where the bot has been, used as input to the
 * search replanner. Sampled at most once per `period_ms`; a new breadcrumb
 * is recorded iff the bot is at least `min_dist` (horizontal) blocks from
 * every breadcrumb already held.
 *
 * Capacity is split across two pools:
 *   - RECENT    (FIFO, size `recent_pool_size`)    — current trajectory.
 *   - LANDMARKS (score-ranked, `landmark_pool_size`) — diverse waypoints.
 *
 * Aged-out recents are offered to the landmark pool; only those that beat
 * the weakest current landmark are kept. Score is computed as:
 *
 *     biome_rarity + block_novelty + spatial_isolation
 *
 * `get_breadcrumbs()` returns RECENT ++ LANDMARKS sorted by horizontal
 * distance from the bot's current position (closest first). The LLM sees
 * one flat list and never has to know about the two-pool internal
 * structure.
 */
export class BreadcrumbTracker {
  constructor(agent, opts = {}) {
    this._agent = agent;
    this._min_dist = opts.min_dist ?? 24;
    this._recent_pool_size = opts.recent_pool_size ?? 16;
    this._landmark_pool_size = opts.landmark_pool_size ?? 48;
    this._period_ms = opts.period_ms ?? 1000;

    this._recent = [];
    this._landmarks = [];
    this._interval_handle = null;
  }

  start() {
    if (this._interval_handle != null) return;
    this._interval_handle =
        setInterval(() => this._sample(), this._period_ms);
    spl.log(`Started (min_dist=${this._min_dist}, recent=${
        this._recent_pool_size}, landmark=${this._landmark_pool_size}).`);
  }

  stop() {
    if (this._interval_handle == null) return;
    clearInterval(this._interval_handle);
    this._interval_handle = null;
    spl.log(`Stopped (held recent=${this._recent.length}, landmark=${
        this._landmarks.length}).`);
  }

  reset() {
    this._recent = [];
    this._landmarks = [];
  }

  /**
   * Returns RECENT ++ LANDMARKS sorted by horizontal distance from the bot's
   * current position (closest first). Defensive copy — internal `_score`
   * cache is stripped on the way out.
   */
  get_breadcrumbs() {
    const all = [...this._recent, ...this._landmarks];

    const pos = this._safe_get_position();
    if (pos == null) {
      return all.map(_strip_score);
    }

    return all
        .map(b => [b, _horizontal_dist_sq(b, pos)])
        .sort((a, b) => a[1] - b[1])
        .map(([b]) => _strip_score(b));
  }

  /* --- internals ---------------------------------------------------- */

  _sample() {
    const pos = this._safe_get_position();
    if (pos == null) return;

    if (!this._far_enough_from_all_kept(pos)) return;

    const breadcrumb = this._build_breadcrumb(pos);
    this._recent.push(breadcrumb);

    if (this._recent.length > this._recent_pool_size) {
      const aged = this._recent.shift();
      this._offer_to_landmarks(aged);
    }
  }

  _far_enough_from_all_kept(pos) {
    const threshold_sq = this._min_dist * this._min_dist;
    for (const b of this._recent) {
      if (_horizontal_dist_sq(b, pos) < threshold_sq) return false;
    }
    for (const b of this._landmarks) {
      if (_horizontal_dist_sq(b, pos) < threshold_sq) return false;
    }
    return true;
  }

  _build_breadcrumb(pos) {
    const bot = this._agent.bot;

    let biome = null;
    try {
      biome = getBiomeName(bot);
    } catch {
    }

    const nearby_block_kinds = [];
    const seen_blocks = new Set();
    for (const block of getNearestBlocks(bot) ?? []) {
      if (COLLECTIBLE_LIQUIDS.has(block.name) && block.metadata !== 0) continue;
      if (seen_blocks.has(block.name)) continue;
      seen_blocks.add(block.name);
      nearby_block_kinds.push(block.name);
    }

    const nearby_mob_kinds = [];
    const seen_mobs = new Set();
    for (const entity of getNearbyEntities(bot) ?? []) {
      if (entity.type === 'player' || entity.name === 'item') continue;
      if (seen_mobs.has(entity.name)) continue;
      seen_mobs.add(entity.name);
      nearby_mob_kinds.push(entity.name);
    }

    return {
      x: Number(pos.x.toFixed(2)),
      y: Number(pos.y.toFixed(2)),
      z: Number(pos.z.toFixed(2)),
      biome,
      nearby_block_kinds,
      nearby_mob_kinds,
    };
  }

  _offer_to_landmarks(candidate) {
    if (this._landmarks.length < this._landmark_pool_size) {
      this._landmarks.push(candidate);
      this._invalidate_cached_scores();
      return;
    }

    const candidate_score = this._score(candidate, this._landmarks);

    let weakest_index = 0;
    let weakest_score = this._cached_score(this._landmarks[0]);
    for (let i = 1; i < this._landmarks.length; i++) {
      const s = this._cached_score(this._landmarks[i]);
      if (s < weakest_score) {
        weakest_score = s;
        weakest_index = i;
      }
    }

    if (candidate_score > weakest_score) {
      this._landmarks[weakest_index] = candidate;
      this._invalidate_cached_scores();
    }
  }

  _cached_score(landmark) {
    if (landmark._score == null) {
      landmark._score = this._score(landmark, this._landmarks);
    }
    return landmark._score;
  }

  _invalidate_cached_scores() {
    for (const l of this._landmarks) l._score = null;
  }

  // score(b) = biome_rarity + block_novelty + spatial_isolation
  _score(candidate, landmark_pool) {
    const others = landmark_pool.filter(l => l !== candidate);

    let same_biome = 0;
    for (const l of others) {
      if (l.biome === candidate.biome) same_biome += 1;
    }
    const biome_rarity = 1 / (same_biome + 1);

    const other_kinds = new Set();
    for (const l of others) {
      for (const k of l.nearby_block_kinds) other_kinds.add(k);
    }
    let block_novelty = 0;
    for (const k of candidate.nearby_block_kinds) {
      if (!other_kinds.has(k)) block_novelty += 1;
    }

    let spatial_isolation;
    if (others.length === 0) {
      spatial_isolation = SPATIAL_ISOLATION_CAP;
    } else {
      let min_dist_sq = Infinity;
      for (const l of others) {
        const d = _horizontal_dist_sq(l, candidate);
        if (d < min_dist_sq) min_dist_sq = d;
      }
      spatial_isolation = Math.min(
          Math.sqrt(min_dist_sq) / this._min_dist, SPATIAL_ISOLATION_CAP);
    }

    return biome_rarity + block_novelty + spatial_isolation;
  }

  _safe_get_position() {
    try {
      const pos = getPosition(this._agent.bot);
      if (pos == null || typeof pos.x !== 'number') return null;
      return pos;
    } catch {
      return null;
    }
  }
}

function _horizontal_dist_sq(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

function _strip_score({_score, ...rest}) {
  return rest;
}
