import path from 'path';

import {readJson, writeJson} from './utils.js';

export const FORCED_BENCHMARK_MODEL = 'gpt-5';

export function readProfileName(profilePath) {
  const profile = readJson(profilePath);
  if (!profile.name) {
    throw new Error(`Profile file is missing a name field: ${profilePath}`);
  }
  return profile.name;
}

export function createBenchmarkProfile({
  sourceProfilePath,
  outputDir,
  forcedModel = FORCED_BENCHMARK_MODEL,
  achievementHunter = false,
}) {
  const profile = readJson(sourceProfilePath);
  profile.model = forcedModel;

  if (achievementHunter) {
    profile.ptd_model = forcedModel;
    profile.ptd_feedback_model = forcedModel;
    profile.ptd_refinement_model = forcedModel;
    profile.failure_replanner_model = forcedModel;
  }

  const outputPath = path.join(outputDir, 'benchmark_profile.json');
  writeJson(outputPath, profile);
  return outputPath;
}
