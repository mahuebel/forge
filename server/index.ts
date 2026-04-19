// server/index.ts
import { join } from "path";
import { parseArgs } from "util";
import { readFileSync } from "fs";
import {
  createSession,
  writePidFile,
  removePidFile,
  writeServerInfo,
  registerActiveSession,
  unregisterActiveSession,
} from "./session";
import { createRouteHandler } from "./routes";
import { ensureRegistry } from "./topics";
import { createContentWatcher } from "./watcher";
import { createBridge } from "./bridge";
import { createHeartbeatEmitter } from "./health";
import { createWatchdog } from "./watchdog";
import { createSequenceCounter, countEvents } from "./events";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: "string", default: "4546" },
    session: { type: "string", default: "forge-" + Date.now() },
    base: { type: "string", default: process.cwd() },
    "claude-pid": { type: "string" },
  },
});

const port = parseInt(values.port!, 10);
const sessionId = values.session!;
const baseDir = values.base!;
const claudePidArg = values["claude-pid"];
const claudePid = claudePidArg ? parseInt(claudePidArg, 10) : undefined;

// publicDir is co-located with this index.ts: server/public
const publicDir = join(import.meta.dir, "public");

// Read plugin version from the manifest so clients (and the SKILL.md
// health check) can detect when a plugin update has happened and a
// restart is required.
function readPluginVersion(): string {
  try {
    const manifestPath = join(import.meta.dir, "..", ".claude-plugin", "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

const pluginVersion = readPluginVersion();

// ── Session setup ──
const paths = await createSession(baseDir, sessionId);
const topicRegistry = await ensureRegistry(paths.root);
console.log("[forge] Session: " + sessionId);
console.log("[forge] Content dir: " + paths.content);
console.log("[forge] Events file: " + paths.eventsFile);
console.log(
  "[forge] Topics: " +
    topicRegistry.topics.map((t) => t.id).join(", ") +
    " (active=" + topicRegistry.activeId + ")"
);

// ── Sequence counter (start after existing events) ──
const existingCount = await countEvents(paths.eventsFile);
const getNextSeq = createSequenceCounter(existingCount);

// ── WebSocket clients ──
const wsClients = new Set<any>();

// ── HTTP + WebSocket server ──
const broadcastToBrowsers = (message: string) => {
  for (const ws of wsClients) ws.send(message);
};

const routeHandler = createRouteHandler({
  paths,
  publicDir,
  getNextSeq,
  broadcastToBrowsers,
  pluginVersion,
});

const server = Bun.serve({
  port,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req);
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return undefined as any;
    }
    return routeHandler(req);
  },
  websocket: {
    open(ws) { wsClients.add(ws); },
    close(ws) { wsClients.delete(ws); },
    message() { /* browser doesn't send WS messages */ },
  },
});

// ── PID + server info ──
await writePidFile(paths.pidFile, process.pid);
const serverInfo = {
  port: server.port,
  url: "http://localhost:" + server.port,
  sessionId,
  contentDir: paths.content,
  eventsFile: paths.eventsFile,
  version: pluginVersion,
  claudePid,
  serverPid: process.pid,
};
await writeServerInfo(paths.serverInfoFile, serverInfo);

// Also register in the global active-sessions directory so the MCP channel
// server (spawned separately by Claude Code --channels) can discover this
// session and tail its events stream.
await registerActiveSession(sessionId, serverInfo);

console.log("[forge] Server running at http://localhost:" + server.port);
console.log("[forge] Registered active session for channel discovery");

// ── File watcher → notify browsers ──
// Watches content/ recursively so any topic's round-*.html changes
// trigger a reload scoped to that topic. The client filters by active
// topic and ignores reload events for other topics it isn't viewing.
const watcher = createContentWatcher(paths.content, (changes) => {
  const summary = changes.map((c) => c.topicId + "/" + c.filename).join(", ");
  console.log("[forge] New/changed files: " + summary);
  const byTopic = new Map<string, string[]>();
  for (const c of changes) {
    const list = byTopic.get(c.topicId) ?? [];
    list.push(c.filename);
    byTopic.set(c.topicId, list);
  }
  for (const [topicId, files] of byTopic) {
    const message = JSON.stringify({ type: "reload", topicId, files });
    for (const ws of wsClients) ws.send(message);
  }
});
watcher.start();

// ── Bridge ──
const bridge = createBridge({
  eventsFile: paths.eventsFile,
  cursorFile: paths.cursorFile,
  onMessage: (formatted) => {
    console.log(formatted);
  },
  debounceMs: 500,
  pollIntervalMs: 200,
});
bridge.start();

// ── Heartbeat ──
const heartbeat = createHeartbeatEmitter({
  intervalMs: 15_000,
  getEventsSent: () => bridge.getEventsSent(),
  onHeartbeat: (event) => {
    console.log(
      "[forge:heartbeat] uptime=" + event.server_uptime_s +
      "s events_sent=" + event.events_sent
    );
  },
});
heartbeat.start();

// ── Orphan watchdog ──
// If the owning Claude Code process exits (clean shutdown, crash, SIGKILL,
// terminal closed), this server has no reason to keep running. Poll the
// owning pid every 10s and shut down when it's gone. Skipped when no
// claudePid was provided (legacy launches or manual debugging).
let watchdog: ReturnType<typeof createWatchdog> | null = null;
if (claudePid !== undefined) {
  watchdog = createWatchdog({
    claudePid,
    intervalMs: 10_000,
    onOrphaned: () => {
      console.log("[forge] Owning Claude pid " + claudePid + " is gone — shutting down");
      void shutdown();
    },
  });
  watchdog.start();
}

// ── Graceful shutdown ──
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[forge] Shutting down...");
  watchdog?.stop();
  heartbeat.stop();
  bridge.stop();
  watcher.stop();
  try {
    await removePidFile(paths.pidFile);
  } catch {}
  try {
    await unregisterActiveSession(sessionId);
  } catch {}
  server.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
