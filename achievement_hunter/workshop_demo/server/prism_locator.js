// Locates the Prism Launcher executable on the presenter's machine. macOS
// only — this whole app targets a single presenter's own laptop, not a
// general deployment.

import {execSync} from 'child_process';
import {existsSync} from 'fs';
import os from 'os';
import path from 'path';

import {PRISM_COMMAND_OVERRIDE} from './config.js';

const CANDIDATE_PATHS = [
  PRISM_COMMAND_OVERRIDE,
  '/Applications/Prism Launcher.app/Contents/MacOS/prismlauncher',
  path.join(
      os.homedir(), 'Applications/Prism Launcher.app/Contents/MacOS/prismlauncher'),
  // Verified present here during development — the presenter may not have
  // moved it into /Applications yet.
  path.join(
      os.homedir(), 'Downloads/Prism Launcher.app/Contents/MacOS/prismlauncher'),
].filter(Boolean);

export function resolvePrismCommand() {
  for (const candidate of CANDIDATE_PATHS) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    const found = execSync('command -v prismlauncher', {encoding: 'utf8'}).trim();
    return found || null;
  } catch {
    return null;
  }
}
