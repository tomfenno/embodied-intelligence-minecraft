import fs from 'fs';
import os from 'os';
import path from 'path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  AdvancementTaskValidator,
} from '../../../evaluation_harness/task_validators.js';

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

describe('AdvancementTaskValidator', () => {
  let tempRoot;
  let serverRoot;
  let worldPath;
  const originalServerRoot = process.env.TASK_SERVER_ROOT;
  const originalWorldPath = process.env.TASK_WORLD_PATH;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'mindcraft-advancement-validator-'));
    serverRoot = path.join(tempRoot, 'server');
    worldPath = path.join(serverRoot, 'world');
    fs.mkdirSync(serverRoot, {recursive: true});
    fs.mkdirSync(worldPath, {recursive: true});
    process.env.TASK_SERVER_ROOT = serverRoot;
    process.env.TASK_WORLD_PATH = worldPath;
  });

  afterEach(() => {
    process.env.TASK_SERVER_ROOT = originalServerRoot;
    process.env.TASK_WORLD_PATH = originalWorldPath;
    fs.rmSync(tempRoot, {recursive: true, force: true});
  });

  function makeValidator() {
    return new AdvancementTaskValidator(
        {advancement_id: 'minecraft:story/mine_stone'},
        {name: 'andy'},
    );
  }

  it('returns invalid when the usercache entry is missing', () => {
    writeJson(path.join(serverRoot, 'usercache.json'), []);

    expect(makeValidator().validate()).toEqual({valid: false, score: 0});
  });

  it('returns invalid when the advancement file is missing', () => {
    writeJson(path.join(serverRoot, 'usercache.json'), [{
      name: 'andy',
      uuid: 'uuid-1234',
    }]);

    expect(makeValidator().validate()).toEqual({valid: false, score: 0});
  });

  it('returns invalid when the advancement is incomplete', () => {
    writeJson(path.join(serverRoot, 'usercache.json'), [{
      name: 'andy',
      uuid: 'uuid-1234',
    }]);
    writeJson(
        path.join(worldPath, 'advancements', 'uuid-1234.json'),
        {
          'minecraft:story/mine_stone': {
            done: false,
          },
        });

    expect(makeValidator().validate()).toEqual({valid: false, score: 0});
  });

  it('returns valid when the advancement is complete', () => {
    writeJson(path.join(serverRoot, 'usercache.json'), [{
      name: 'andy',
      uuid: 'uuid-1234',
    }]);
    writeJson(
        path.join(worldPath, 'advancements', 'uuid-1234.json'),
        {
          'minecraft:story/mine_stone': {
            done: true,
          },
        });

    expect(makeValidator().validate()).toEqual({valid: true, score: 1});
  });
});
