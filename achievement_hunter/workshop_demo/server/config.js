// Single place for every setting the workshop demo's presenter might need
// to tune for their own machine — consolidated here (Phase 6) so nothing
// is buried inside the module that happens to use it. Every value is
// overridable via a WORKSHOP_DEMO_* env var; defaults match what's already
// verified working on the development machine (see PLAN.md).
//
//   WORKSHOP_DEMO_PORT                 dashboard HTTP port
//   WORKSHOP_DEMO_MINECRAFT_VERSION    Minecraft version for the managed world
//   WORKSHOP_DEMO_SERVER_TEMPLATE_PATH repo-root-relative server template dir
//   WORKSHOP_DEMO_SERVER_JAR_NAME      jar to launch inside that template
//   WORKSHOP_DEMO_AGENT_NAME           must match profile.json's "name"
//   WORKSHOP_DEMO_PRISM_COMMAND        path to the Prism executable
//   WORKSHOP_DEMO_PRISM_INSTANCE       Prism instance ID to launch
//   WORKSHOP_DEMO_SPECTATOR_USERNAME   offline username the spectator joins as

// Pinned away from prismarine-viewer's 3000-3003 range and mindserver's
// 8080 default — see PLAN.md Phase 4's port-collision note.
export const DASHBOARD_PORT = Number(process.env.WORKSHOP_DEMO_PORT) || 4173;

// Peaceful survival, matching evaluation_harness/advancement_tester_smoke.json's
// world block, but on a Fabric server (not the eval harness's own vanilla
// template — benchmark runs should stay on a clean, unmodified server for
// reproducibility). Fabric + Fabric API + Fabric Tailor let AH_Bot's
// profile.json `skin` field actually take effect via the `/skin set URL`
// command agent.js already sends automatically on login. Point
// server_template_path back at the eval harness's vanilla template (and
// server_jar_name at 'server.jar') if mods are ever unwanted.
export const WORLD_CONFIG = {
  minecraft_version: process.env.WORKSHOP_DEMO_MINECRAFT_VERSION || '1.21.6',
  server_template_path: process.env.WORKSHOP_DEMO_SERVER_TEMPLATE_PATH ||
      'achievement_hunter/workshop_demo/server_templates/minecraft_1_21_6_fabric',
  server_jar_name:
      process.env.WORKSHOP_DEMO_SERVER_JAR_NAME || 'fabric-server-launch.jar',
  difficulty: 'peaceful',
  gamemode: 'survival',
  generate_structures: true,
  allow_cheats: false,
  level_name: 'world',
};

// Must match achievement_hunter/src/profile.json's "name" field — the
// bot's identity on the mindserver, used as the objective-injection and
// /spectate target.
export const AGENT_NAME = process.env.WORKSHOP_DEMO_AGENT_NAME || 'AH_Bot';

// Explicit override for prism_locator.js's search; leave unset to
// auto-detect (checks /Applications, ~/Applications, ~/Downloads, then PATH).
export const PRISM_COMMAND_OVERRIDE =
    process.env.WORKSHOP_DEMO_PRISM_COMMAND || null;

// Prism instance ID to launch (must already exist — created once by the
// presenter ahead of the workshop, matching WORLD_CONFIG.minecraft_version).
export const PRISM_INSTANCE = process.env.WORKSHOP_DEMO_PRISM_INSTANCE || '1.21.6';

// Offline-mode username the spectator client joins as (server has
// online-mode: false, so no real Microsoft account is required).
export const SPECTATOR_USERNAME =
    process.env.WORKSHOP_DEMO_SPECTATOR_USERNAME || 'Spectator';
