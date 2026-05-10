import fs from 'fs';
import path from 'path';

import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

import {
  appendOrReplaceManifest,
  loadJsonl,
  writeResultsJsonl,
  writeSummaryReports,
} from './lib/reports.js';
import {
  ensureDirectory,
  resolveProjectPath,
  walkFiles,
} from './lib/utils.js';

const argv = await yargs(hideBin(process.argv))
    .option('output', {
      type: 'string',
      demandOption: true,
      describe: 'Output suite directory for merged results',
    })
    .option('input', {
      type: 'string',
      array: true,
      demandOption: true,
      describe: 'Input results.jsonl files or directories; repeatable',
    })
    .strict()
    .help()
    .parse();

try {
  const manifests = [];
  for (const inputValue of argv.input) {
    for (const manifest of loadInputManifests(resolveProjectPath(inputValue))) {
      const next = appendOrReplaceManifest(manifests, manifest);
      manifests.splice(0, manifests.length, ...next);
    }
  }

  const outputDir = resolveProjectPath(argv.output);
  ensureDirectory(outputDir);
  writeResultsJsonl(path.join(outputDir, 'results.jsonl'), manifests);
  writeSummaryReports(outputDir, manifests);
} catch (error) {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
}

function loadInputManifests(inputPath) {
  if (fs.existsSync(inputPath) && fs.statSync(inputPath).isFile()) {
    if (path.basename(inputPath) === 'results.jsonl') {
      return loadJsonl(inputPath);
    }
    if (path.basename(inputPath) === 'episode_manifest.json') {
      return [JSON.parse(fs.readFileSync(inputPath, 'utf8'))];
    }
    throw new Error(`Unsupported input file: ${inputPath}`);
  }

  if (fs.existsSync(path.join(inputPath, 'results.jsonl'))) {
    return loadJsonl(path.join(inputPath, 'results.jsonl'));
  }

  const manifests = [];
  for (const filePath of walkFiles(inputPath)) {
    if (path.basename(filePath) !== 'episode_manifest.json') continue;
    manifests.push(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  }
  return manifests;
}
