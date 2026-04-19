#!/usr/bin/env bun
// channel/server.ts
//
// Forge channel server — an MCP server that pushes forge workspace events
// into a running Claude Code session via the `claude/channel` capability.
//
// How it fits in:
//
//   [browser] → POST /api/events → [HTTP server] → events.jsonl (on disk)
//                                                         │
//                                                         ├─► bridge.ts (stdout log)
//                                                         │
//                                                         └─► THIS FILE (MCP channel)
//                                                                     │
//                                                                     └─► <channel source="forge" …> tag
//                                                                         in Claude Code session
//
// This process is spawned by Claude Code when the user runs:
//   claude --channels plugin:forge@forge-marketplace
// It communicates with Claude Code over stdio (MCP transport).
//
// On startup we scan ~/.claude/forge/active-sessions/ for running HTTP
// servers and begin tailing each one's events.jsonl. We also watch the
// directory for newly-registered sessions so we pick them up mid-session.
//
// Two-way: Claude can call the `notify-workspace` tool to send a
// human-readable toast back to every connected browser via the HTTP
// server's WebSocket broadcast (the HTTP server listens for this via
// POST /api/toast).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { watch, existsSync, readdirSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const ACTIVE_SESSIONS_DIR = join(homedir(), ".claude", "forge", "active-sessions");
const POLL_INTERVAL_MS = 300;

// The PID of our parent process. When Claude Code spawns this MCP server via
// .mcp.json, the parent is the Claude Code process itself. The forge HTTP
// server records the same PID in its server-info.json (passed in via
// --claude-pid "$PPID" from the skill's bash launch, where $PPID is also the
// Claude Code PID for the same reason). Matching on this value is how we
// route events to the correct Claude session when multiple are running.
const OWNER_PID = process.ppid;

interface SessionInfo {
  port: number;
  url: string;
  sessionId: string;
  contentDir: string;
  eventsFile: string;
  claudePid?: number;
}

function isLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function shouldOwn(info: SessionInfo): boolean {
  // Strict match: only claim workspaces explicitly tagged with our PID.
  // Legacy (pre-0.3.3) workspaces without `claudePid` are ignored here —
  // the developer must restart them via the skill for the new routing to
  // take effect. Lenient claiming (adopting unowned workspaces) would
  // regress the original multi-session misdelivery bug.
  if (typeof info.claudePid !== "number") return false;
  if (info.claudePid !== OWNER_PID) return false;
  // Belt-and-suspenders: if somehow our PPID reused a slot from a long-dead
  // Claude that had launched this workspace, refuse to adopt.
  if (!isLivePid(info.claudePid)) return false;
  return true;
}

// --- Track which sessions we're tailing and how far we've pushed ------------

interface TrackedSession {
  info: SessionInfo;
  cursorFile: string; // separate from bridge cursor: tracks channel-pushed position
  pollTimer?: ReturnType<typeof setInterval>;
}

const tracked = new Map<string, TrackedSession>();

// --- MCP Server --------------------------------------------------------------

const mcp = new Server(
  { name: "forge", version: "0.3.3" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      "Events from the forge visual workspace arrive as <channel source=\"forge\" ...> tags.",
      "Each event has a `type` attribute: verdict, annotate, select, round, refine.",
      "",
      "Response rules:",
      "- type=\"verdict\": acknowledge immediately, note what worked or didn't",
      "- type=\"annotate\": acknowledge the note, confirm it's queued for the next round",
      "- type=\"select\": accumulate silently, don't reply per click",
      "- type=\"refine\": generate the next round of variations incorporating all accumulated feedback. Write files named round-N-{a,b,c}.html to <contentDir>/<topic_id>/, then append a round event (with the same topic_id) to eventsFile.",
      "- type=\"round\": informational, don't reply",
      "",
      "The `session_id` attribute identifies which forge session the event came from. The `topic_id` attribute (when present) identifies which `/forge` invocation within that session — a single session can host many topics side-by-side. Always scope file writes and round events to the event's topic_id.",
      "",
      "You can call the `notify-workspace` tool to show a toast message in the developer's browser (useful when acknowledging a refine request before you've finished writing the new round).",
    ].join("\n"),
  }
);

// --- notify-workspace reply tool --------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "notify-workspace",
      description:
        "Show a toast notification in the forge browser workspace. Use this to acknowledge refine requests or any action that takes more than a few seconds, so the developer knows you're working.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description: "The forge session id (from the event's session_id meta attribute)",
          },
          message: {
            type: "string",
            description: "The message to show as a toast. Keep it short — one sentence.",
          },
        },
        required: ["session_id", "message"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "notify-workspace") {
    const { session_id, message } = req.params.arguments as {
      session_id: string;
      message: string;
    };
    const session = tracked.get(session_id);
    if (!session) {
      return {
        content: [{ type: "text", text: "unknown session: " + session_id }],
        isError: true,
      };
    }
    try {
      await fetch(session.info.url + "/api/toast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      return { content: [{ type: "text", text: "toast sent" }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: "failed to send toast: " + (err as Error).message }],
        isError: true,
      };
    }
  }
  throw new Error("unknown tool: " + req.params.name);
});

// --- Session discovery + polling --------------------------------------------

async function loadSessionInfo(file: string): Promise<SessionInfo | null> {
  try {
    const content = await readFile(file, "utf-8");
    return JSON.parse(content) as SessionInfo;
  } catch {
    return null;
  }
}

async function readCursor(cursorFile: string): Promise<number> {
  try {
    const content = await readFile(cursorFile, "utf-8");
    return parseInt(content.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

async function writeCursor(cursorFile: string, pos: number): Promise<void> {
  await writeFile(cursorFile, String(pos));
}

async function pollSession(sessionId: string): Promise<void> {
  const session = tracked.get(sessionId);
  if (!session) return;

  try {
    const cursor = await readCursor(session.cursorFile);
    const content = await readFile(session.info.eventsFile, "utf-8");
    if (!content.trim()) return;

    const lines = content.trim().split("\n").filter(Boolean);
    if (cursor >= lines.length) return;

    const unsent = lines.slice(cursor);
    let pushed = 0;

    for (const line of unsent) {
      try {
        const event = JSON.parse(line);
        if (event.type === "heartbeat") {
          pushed++;
          continue; // skip heartbeats — noisy in channel
        }
        await pushEvent(sessionId, event);
        pushed++;
      } catch {
        pushed++; // advance past malformed lines so we don't loop
      }
    }

    await writeCursor(session.cursorFile, cursor + pushed);
  } catch {
    // File read error — retry on next poll
  }
}

async function pushEvent(sessionId: string, event: Record<string, unknown>): Promise<void> {
  const session = tracked.get(sessionId);
  if (!session) return;

  // Build the event body and meta tags
  const meta: Record<string, string> = {
    session_id: sessionId,
    content_dir: session.info.contentDir,
    events_file: session.info.eventsFile,
    workspace_url: session.info.url,
    event_type: String(event.type ?? "unknown"),
  };
  if (typeof event.variation === "string") meta.variation = event.variation;
  if (typeof event.action === "string") meta.action = event.action;
  if (typeof event.pin === "number") meta.pin = String(event.pin);
  if (typeof event.round === "number") meta.round = String(event.round);
  if (typeof event.topic_id === "string") meta.topic_id = event.topic_id;

  const content = formatEventBody(event);

  await mcp.notification({
    method: "notifications/claude/channel",
    params: { content, meta },
  });
}

function formatEventBody(event: Record<string, unknown>): string {
  const type = event.type;
  const topicPrefix = typeof event.topic_id === "string"
    ? `[topic: ${event.topic_id}] `
    : "";
  switch (type) {
    case "verdict": {
      const v = String(event.variation ?? "?").toUpperCase();
      const action = event.action === "like" ? "liked" : "rejected";
      const reason = event.reason ? ` — "${event.reason}"` : "";
      return `${topicPrefix}Variation ${v} ${action}${reason}`;
    }
    case "annotate": {
      const v = String(event.variation ?? "?").toUpperCase();
      if (event.shape === "general" || !event.variation) {
        return `${topicPrefix}General note (#${event.pin}): "${event.text}"`;
      }
      return `${topicPrefix}Annotation on Variation ${v} (pin #${event.pin}, near ${event.selector}): "${event.text}"`;
    }
    case "select": {
      const v = String(event.variation ?? "?").toUpperCase();
      const action = event.action === "like" ? "liked" : "rejected";
      return `${topicPrefix}Component on Variation ${v} ${action}: "${event.label}" (${event.selector})`;
    }
    case "round": {
      const vs = (event.variations as string[] | undefined) ?? [];
      return `${topicPrefix}Round ${event.round} generated: variations ${vs.join(", ")}. Prompt: "${event.prompt}"`;
    }
    case "refine": {
      return `${topicPrefix}Developer clicked Refine. Generate the next round of variations incorporating all accumulated feedback — reference specific likes, annotations, and rejections, then write the new round's HTML files and append a round event to the events file.`;
    }
    default:
      return JSON.stringify(event);
  }
}

async function startTracking(info: SessionInfo): Promise<void> {
  if (tracked.has(info.sessionId)) return;

  // Cursor file lives in the session's bridge/ directory, next to the
  // main bridge cursor but distinct. We include OWNER_PID in the name so
  // that even if two channel-server processes somehow end up tracking the
  // same workspace (they shouldn't, given shouldOwn), they can't race each
  // other to advance a shared cursor and cause misdelivery.
  const sessionRoot = info.eventsFile.replace(/\/state\/events\.jsonl$/, "");
  const cursorFile = join(sessionRoot, "bridge", "channel-cursor-" + OWNER_PID);

  if (!existsSync(cursorFile)) {
    try {
      await writeFile(cursorFile, "0");
    } catch {}
  }

  const entry: TrackedSession = { info, cursorFile };
  tracked.set(info.sessionId, entry);

  entry.pollTimer = setInterval(() => {
    pollSession(info.sessionId).catch(() => {});
  }, POLL_INTERVAL_MS);

  process.stderr.write("[forge-channel] tracking session " + info.sessionId + " at " + info.url + "\n");
}

async function stopTracking(sessionId: string): Promise<void> {
  const entry = tracked.get(sessionId);
  if (!entry) return;
  if (entry.pollTimer) clearInterval(entry.pollTimer);
  tracked.delete(sessionId);
  process.stderr.write("[forge-channel] stopped tracking session " + sessionId + "\n");
}

async function scanActiveSessions(): Promise<void> {
  if (!existsSync(ACTIVE_SESSIONS_DIR)) return;
  const files = readdirSync(ACTIVE_SESSIONS_DIR);
  const seen = new Set<string>();

  for (const name of files) {
    if (!name.endsWith(".json")) continue;
    const info = await loadSessionInfo(join(ACTIVE_SESSIONS_DIR, name));
    if (!info) continue;
    if (!shouldOwn(info)) continue;
    seen.add(info.sessionId);
    if (!tracked.has(info.sessionId)) {
      await startTracking(info);
    }
  }

  // Clean up sessions that disappeared
  for (const id of tracked.keys()) {
    if (!seen.has(id)) {
      await stopTracking(id);
    }
  }
}

// --- Boot --------------------------------------------------------------------

async function main() {
  // Ensure the directory exists so fs.watch doesn't throw on an empty path
  await mkdir(ACTIVE_SESSIONS_DIR, { recursive: true });

  // Initial scan
  await scanActiveSessions();

  // Watch for new/removed sessions
  watch(ACTIVE_SESSIONS_DIR, { persistent: true }, () => {
    scanActiveSessions().catch(() => {});
  });

  // Connect to Claude Code over stdio
  await mcp.connect(new StdioServerTransport());

  process.stderr.write("[forge-channel] connected to Claude Code\n");
}

main().catch((err) => {
  process.stderr.write("[forge-channel] fatal: " + (err?.message ?? err) + "\n");
  process.exit(1);
});
