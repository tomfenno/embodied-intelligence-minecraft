import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import {spawn} from 'child_process';
import {fileURLToPath} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, '../../..');
export const ACHIEVEMENT_HUNTER_ROOT =
    path.resolve(__dirname, '../..');

export function resolveProjectPath(pathValue) {
  if (!pathValue) return pathValue;
  if (path.isAbsolute(pathValue)) return path.normalize(pathValue);
  return path.normalize(path.join(PROJECT_ROOT, pathValue));
}

export function ensureDirectory(pathValue) {
  fs.mkdirSync(pathValue, {recursive: true});
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return readJson(filePath);
}

export function writeJson(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

export function safeRemoveTree(targetPath, allowedRoot) {
  if (!targetPath || !fs.existsSync(targetPath)) return;

  const targetAbs = path.resolve(targetPath);
  const allowedAbs = path.resolve(allowedRoot);
  const relativePath = path.relative(allowedAbs, targetAbs);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Refusing to delete path outside allowed root: ${targetAbs}`);
  }
  fs.rmSync(targetAbs, {recursive: true, force: true});
}

export function copyFileIfExists(sourcePath, destPath) {
  if (!fs.existsSync(sourcePath)) return;
  ensureDirectory(path.dirname(destPath));
  fs.copyFileSync(sourcePath, destPath);
}

export function* walkFiles(rootPath) {
  if (!rootPath || !fs.existsSync(rootPath)) return;

  for (const entry of fs.readdirSync(rootPath, {withFileTypes: true})) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(entryPath);
    } else if (entry.isFile()) {
      yield entryPath;
    }
  }
}

export function copyFilesModifiedSince(
    sourceRoot, destRoot, startTimeMs, {exclude = []} = {}) {
  if (!sourceRoot || !fs.existsSync(sourceRoot)) return;

  for (const sourcePath of walkFiles(sourceRoot)) {
    const relativePath = path.relative(sourceRoot, sourcePath);
    if (exclude.some((segment) => relativePath.startsWith(segment))) {
      continue;
    }

    const modifiedTimeMs = fs.statSync(sourcePath).mtimeMs;
    if (modifiedTimeMs + 1000 < startTimeMs) {
      continue;
    }

    const destPath = path.join(destRoot, relativePath);
    ensureDirectory(path.dirname(destPath));
    fs.copyFileSync(sourcePath, destPath);
  }
}

export function updatePropertiesFile(filePath, overrides) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const seenKeys = new Set();
  const updatedLines = [];

  for (const line of lines) {
    if (!line.includes('=') || line.trimStart().startsWith('#')) {
      updatedLines.push(line);
      continue;
    }

    const [key] = line.split('=', 1);
    if (Object.hasOwn(overrides, key)) {
      updatedLines.push(`${key}=${formatPropertyValue(overrides[key])}`);
      seenKeys.add(key);
    } else {
      updatedLines.push(line);
    }
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (!seenKeys.has(key)) {
      updatedLines.push(`${key}=${formatPropertyValue(value)}`);
    }
  }

  fs.writeFileSync(filePath, `${updatedLines.join(os.EOL)}${os.EOL}`, 'utf8');
}

function formatPropertyValue(value) {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return String(value);
}

export async function chooseFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address();
      server.close(() => resolve(port));
    });
  });
}

export async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function serverLogIndicatesReady(outputPath) {
  if (!outputPath || !fs.existsSync(outputPath)) return false;
  try {
    const content = fs.readFileSync(outputPath, 'utf8');
    return content.includes('Done (') ||
        content.includes('For help, type "help"');
  } catch {
    return false;
  }
}

async function canConnect(host, port) {
  return await new Promise((resolve) => {
    const socket = net.createConnection({host, port});
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export async function waitForServerReady({
  host = '127.0.0.1',
  port,
  process,
  outputPath,
  timeoutMs = 180_000,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(
          `Minecraft server exited before becoming ready on port ${port} ` +
          `with return code ${process.exitCode}.`);
    }

    if (serverLogIndicatesReady(outputPath) && await canConnect(host, port)) {
      return;
    }

    await sleep(2_000);
  }

  throw new Error(
      `Minecraft server did not start on port ${port} within ${timeoutMs}ms`);
}

export function launchLoggedProcess({command, cwd, outputPath, env = process.env}) {
  ensureDirectory(path.dirname(outputPath));
  const outputHandle = fs.createWriteStream(outputPath, {flags: 'w'});
  const child = spawn(command[0], command.slice(1), {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  child.stdout.pipe(outputHandle);
  child.stderr.pipe(outputHandle);
  return {child, outputHandle};
}

export async function waitForProcessExit(processHandle, timeoutMs) {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Process timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    processHandle.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(code);
    });

    processHandle.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
  });
}

export function terminateProcessTree(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) return;

  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(processHandle.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      process.kill(-processHandle.pid, 'SIGTERM');
    }
  } catch (error) {
    console.error(
        `Failed to terminate process tree for PID ${processHandle.pid}:`,
        error);
  }
}

export async function stopServerProcess(processHandle) {
  if (!processHandle || processHandle.exitCode !== null) {
    return processHandle?.exitCode ?? null;
  }

  try {
    processHandle.stdin?.write('stop\n');
  } catch (error) {
    console.error('Failed to send stop command to Minecraft server:', error);
  }

  try {
    return await waitForProcessExit(processHandle, 60_000);
  } catch {
    terminateProcessTree(processHandle);
    try {
      return await waitForProcessExit(processHandle, 15_000);
    } catch {
      return null;
    }
  }
}

export function makeTempDir(prefix, rootPath = path.join(PROJECT_ROOT, 'tmp')) {
  ensureDirectory(rootPath);
  return fs.mkdtempSync(path.join(rootPath, prefix));
}

export function readTextIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}
