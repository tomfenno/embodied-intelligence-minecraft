// Auto-joins the presenter's Minecraft client to the demo world as a
// spectator (Phase 5). Best-effort: a Prism/client hiccup here should never
// block the actual agent run, so callers treat this as fire-and-forget
// alongside the main orchestration chain — see orchestrator.js.

import {existsSync, readFileSync} from 'fs';
import {execFileSync, spawn} from 'child_process';
import path from 'path';

import {PRISM_INSTANCE, SPECTATOR_USERNAME} from './config.js';
import {resolvePrismCommand} from './prism_locator.js';

function escape_regex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Walks up from the resolved binary path to find the enclosing .app bundle
// — needed to launch via `open -a`, which wants the bundle, not the inner
// executable.
function resolveAppBundlePath(binaryPath) {
  let dir = path.dirname(binaryPath);
  while (dir !== path.dirname(dir)) {
    if (dir.endsWith('.app')) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

// Vanilla Minecraft has no external command channel into an already-running
// client — launch-time flags like Prism's -s only take effect at process
// start, confirmed live: a repeat `-l -s` against a still-open client from
// a prior run silently failed to rejoin, then succeeded immediately once
// that stale client was killed first. So a clean relaunch is the only
// reliable way to redirect the spectator to a new world, not a fallback.
// SIGKILL (-9) is used rather than a graceful term since there's no game
// state worth protecting on the spectator side.
//
// Matches on the bundle-relative suffix (e.g. "Prism Launcher.app/Contents/
// MacOS/prismlauncher"), not the full resolved path — macOS "App
// Translocation" runs quarantined apps (anything not yet moved out of
// ~/Downloads/Desktop/a mounted disk image) from a randomized temp path, so
// a full-path pattern silently stops matching the actual running process.
// Confirmed live: the launcher process's real argv[0] was under
// /private/var/folders/.../AppTranslocation/<uuid>/d/Prism Launcher.app/...,
// not the original ~/Downloads path.
function killExistingClient(bundlePath) {
  const bundleName = path.basename(bundlePath);
  const patterns = [
    `${bundleName}/Contents/MacOS/prismlauncher`,
    'org.prismlauncher.EntryPoint',
  ];
  for (const pattern of patterns) {
    try {
      execFileSync('pkill', ['-9', '-f', pattern]);
    } catch {
      // pkill exits non-zero when no process matches — not an error.
    }
  }
}

// Launches the presenter's Prism instance and joins it directly to the
// given server — Prism's own --launch/--server direct-join flags (confirmed
// via `prismlauncher --help` on this machine), not a driven-UI or
// reimplemented-auth approach.
//
// Launched via `open -n -a <bundle> --args ...` rather than spawning the
// inner binary directly — required for the window-positioning script
// (Prism's PreLaunchCommand, see scripts/position_window.sh) to work at
// all: macOS's Accessibility permission check resolves back to whichever
// app macOS considers "responsible" for the process tree, and a raw
// spawn() of the binary keeps that responsibility with this Node process
// (so granting Accessibility to Prism Launcher had no effect) — `open -a`
// launches through LaunchServices instead, which makes Prism its own
// responsible app. Confirmed live: identical PreLaunchCommand script
// failed with "assistive access not allowed" under a raw spawn() and
// succeeded under `open -a`, with Accessibility granted only to Prism.
export async function launchPrismSpectator({host, port}) {
  const command = resolvePrismCommand();
  if (!command) {
    return {launched: false, reason: 'Prism Launcher executable not found'};
  }

  const bundlePath = resolveAppBundlePath(command);
  if (!bundlePath) {
    return {launched: false, reason: `Could not resolve .app bundle from ${command}`};
  }

  killExistingClient(bundlePath);
  await new Promise((resolve) => setTimeout(resolve, 2000));

  spawn(
      'open',
      [
        '-n', '-a', bundlePath, '--args',
        '-l', PRISM_INSTANCE,
        '-s', `${host}:${port}`,
        '-o', SPECTATOR_USERNAME,
        '--show-window',
      ],
      {detached: true, stdio: 'ignore'})
      .unref();

  return {launched: true, command: bundlePath, instance: PRISM_INSTANCE};
}

// Polls the managed server's stdout log for a given player/bot's login
// line — the same server-log signal Phase 1 used to confirm the agent
// connected. Generic over username so it can wait for either the
// spectator or the bot.
export async function waitForPlayerLogin(
    serverOutputPath, username, {timeoutMs = 120_000, pollMs = 2000} = {}) {
  const pattern = new RegExp(
      `\\]: ${escape_regex(username)}\\[[^\\]]*\\] logged in with entity id`);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (existsSync(serverOutputPath)) {
      const content = readFileSync(serverOutputPath, 'utf8');
      if (pattern.test(content)) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return false;
}

// Vanilla Minecraft drops /spectate's camera lock whenever the spectated
// entity leaves the world — the bot crashing, "Safely restarting to update
// inventory" (achievement_agent.js's RESTART_MSG path), or any other
// reconnect all produce a fresh login line with a new entity id. This
// counts login-line occurrences for `botName` and calls `onLogin` every
// time that count increases — once for the initial connection, and again
// for each subsequent reconnect — so the caller can re-issue /spectate
// each time rather than only once at startup.
//
// Returns a stop function; callers must call it on teardown or this leaks
// a running timer.
export function watchBotLogins(serverOutputPath, botName, onLogin, {pollMs = 2000} = {}) {
  const pattern = new RegExp(
      `\\]: ${escape_regex(botName)}\\[[^\\]]*\\] logged in with entity id`, 'g');
  let seenCount = 0;

  const check = () => {
    if (!existsSync(serverOutputPath)) return;
    const content = readFileSync(serverOutputPath, 'utf8');
    const count = (content.match(pattern) || []).length;
    if (count > seenCount) {
      seenCount = count;
      onLogin();
    }
  };

  check();
  const timer = setInterval(check, pollMs);
  return () => clearInterval(timer);
}
