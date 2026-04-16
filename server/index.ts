// server/index.ts
import { join } from "path";
import { parseArgs } from "util";
import {
  createSession,
  writePidFile,
  removePidFile,
  writeServerInfo,
} from "./session";
import { createRouteHandler } from "./routes";
import { createContentWatcher } from "./watcher";
import { createBridge } from "./bridge";
import { createHeartbeatEmitter } from "./health";
import { createSequenceCounter, countEvents } from "./events";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: "string", default: "4546" },
    session: { type: "string", default: "forge-" + Date.now() },
    base: { type: "string", default: process.cwd() },
  },
});

const port = parseInt(values.port!, 10);
const sessionId = values.session!;
const baseDir = values.base!;

// publicDir is co-located with this index.ts: server/public
const publicDir = join(import.meta.dir, "public");

// ── Session setup ──
const paths = await createSession(baseDir, sessionId);
console.log("[forge] Session: " + sessionId);
console.log("[forge] Content dir: " + paths.content);
console.log("[forge] Events file: " + paths.eventsFile);

// ── Sequence counter (start after existing events) ──
const existingCount = await countEvents(paths.eventsFile);
const getNextSeq = createSequenceCounter(existingCount);

// ── WebSocket clients ──
const wsClients = new Set<any>();

// ── HTTP + WebSocket server ──
const routeHandler = createRouteHandler({ paths, publicDir, getNextSeq });

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
await writeServerInfo(paths.serverInfoFile, {
  port: server.port,
  url: "http://localhost:" + server.port,
  sessionId,
  contentDir: paths.content,
  eventsFile: paths.eventsFile,
});

console.log("[forge] Server running at http://localhost:" + server.port);

// ── File watcher → notify browsers ──
const watcher = createContentWatcher(paths.content, (files) => {
  console.log("[forge] New/changed files: " + files.join(", "));
  const message = JSON.stringify({ type: "reload", files });
  for (const ws of wsClients) {
    ws.send(message);
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

// ── Graceful shutdown ──
async function shutdown() {
  console.log("[forge] Shutting down...");
  heartbeat.stop();
  bridge.stop();
  watcher.stop();
  try {
    await removePidFile(paths.pidFile);
  } catch {}
  server.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
