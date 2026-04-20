import { join } from "path";
import { existsSync, readdirSync } from "fs";
import { appendEvent, readEvents, type ForgeEvent, type RoundEvent } from "./events";
import type { SessionPaths } from "./session";
import {
  DEFAULT_TOPIC_ID,
  createTopic,
  isValidTopicId,
  readRegistry,
  setActiveTopic,
  topicContentDir,
} from "./topics";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RouteHandlerConfig {
  paths: SessionPaths;
  publicDir: string;
  getNextSeq: () => number;
  broadcastToBrowsers?: (message: string) => void;
  /** Plugin version — surfaced in /health so the skill can detect
   * when a running server is from an older plugin version. */
  pluginVersion?: string;
}

// ─── Module-level uptime reference ───────────────────────────────────────────

const startTime = Date.now();

// ─── CORS headers ────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// ─── Valid event types ────────────────────────────────────────────────────────

const VALID_TYPES = new Set(["select", "annotate", "verdict", "refine", "accept"]);

// ─── Topic helpers ────────────────────────────────────────────────────────────

function topicOf(e: ForgeEvent): string {
  return e.topic_id ?? DEFAULT_TOPIC_ID;
}

async function activeTopicId(paths: SessionPaths): Promise<string> {
  const reg = await readRegistry(paths.root);
  return reg?.activeId ?? DEFAULT_TOPIC_ID;
}

// ─── Content-type map for static files ───────────────────────────────────────

function contentTypeForExt(filename: string): string {
  if (filename.endsWith(".css")) return "text/css; charset=utf-8";
  if (filename.endsWith(".js")) return "application/javascript; charset=utf-8";
  return "text/html; charset=utf-8";
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createRouteHandler(
  config: RouteHandlerConfig
): (req: Request) => Promise<Response> {
  const { paths, publicDir, getNextSeq, broadcastToBrowsers, pluginVersion } = config;

  return async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method;

    // OPTIONS — CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // GET /health
    if (method === "GET" && pathname === "/health") {
      return jsonResponse({
        status: "ok",
        uptime_s: (Date.now() - startTime) / 1000,
        version: pluginVersion ?? "unknown",
      });
    }

    // GET /api/topics
    if (method === "GET" && pathname === "/api/topics") {
      const registry = await readRegistry(paths.root);
      if (!registry) {
        return jsonResponse({ topics: [], activeId: DEFAULT_TOPIC_ID });
      }
      return jsonResponse(registry);
    }

    // POST /api/topics — create a new topic
    if (method === "POST" && pathname === "/api/topics") {
      let body: { id?: unknown; title?: unknown; prompt?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonResponse({ error: "Invalid JSON" }, 400);
      }
      if (typeof body.title !== "string" || !body.title.trim()) {
        return jsonResponse({ error: "title required" }, 400);
      }
      try {
        const result = await createTopic(paths.root, {
          id: typeof body.id === "string" ? body.id : undefined,
          title: body.title,
          prompt: typeof body.prompt === "string" ? body.prompt : undefined,
        });
        return jsonResponse(
          { topic: result.topic, contentDir: result.contentDir },
          201
        );
      } catch (err) {
        return jsonResponse({ error: (err as Error).message }, 409);
      }
    }

    // POST /api/topics/active — switch active topic
    if (method === "POST" && pathname === "/api/topics/active") {
      let body: { id?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonResponse({ error: "Invalid JSON" }, 400);
      }
      if (!isValidTopicId(body.id)) {
        return jsonResponse({ error: "invalid topic id" }, 400);
      }
      const reg = await setActiveTopic(paths.root, body.id);
      if (!reg) return jsonResponse({ error: "unknown topic" }, 404);
      return jsonResponse(reg);
    }

    // GET /api/state?topic=X
    if (method === "GET" && pathname === "/api/state") {
      const topicParam = url.searchParams.get("topic");
      const topicId = isValidTopicId(topicParam) ? topicParam : await activeTopicId(paths);

      const allEvents = await readEvents(paths.eventsFile);
      const events = allEvents.filter((e) => topicOf(e) === topicId);

      let variations: string[] = [];
      const contentDir = topicContentDir(paths.root, topicId);
      if (existsSync(contentDir)) {
        variations = readdirSync(contentDir)
          .filter((f) => f.endsWith(".html"))
          .sort();
      }

      const lastRound = events
        .filter((e): e is RoundEvent => e.type === "round")
        .pop();
      const round = lastRound?.round ?? 0;

      return jsonResponse({
        topicId,
        variations,
        round,
        eventCount: events.length,
      });
    }

    // GET /api/events?topic=X
    if (method === "GET" && pathname === "/api/events") {
      const topicParam = url.searchParams.get("topic");
      const all = await readEvents(paths.eventsFile);
      if (!topicParam) return jsonResponse(all);
      if (!isValidTopicId(topicParam)) {
        return jsonResponse({ error: "invalid topic id" }, 400);
      }
      return jsonResponse(all.filter((e) => topicOf(e) === topicParam));
    }

    // POST /api/events
    if (method === "POST" && pathname === "/api/events") {
      let body: Record<string, unknown>;
      try {
        body = await req.json();
      } catch {
        return jsonResponse({ error: "Invalid JSON" }, 400);
      }

      if (typeof body.type !== "string" || !VALID_TYPES.has(body.type)) {
        return jsonResponse({ error: "Invalid event type" }, 400);
      }

      // Normalize topic_id: keep a valid one, otherwise stamp with the
      // current active topic. Pre-topic clients that omit the field end
      // up on whichever topic is currently active, which matches what a
      // user would expect when interacting with the UI.
      let topicId: string;
      if (isValidTopicId(body.topic_id)) {
        topicId = body.topic_id;
      } else {
        topicId = await activeTopicId(paths);
      }

      const event: ForgeEvent = {
        ...body,
        topic_id: topicId,
        seq: getNextSeq(),
        timestamp: Date.now(),
      } as ForgeEvent;

      await appendEvent(paths.eventsFile, event);
      return jsonResponse(event, 201);
    }

    // POST /api/toast — channel server calls this to show a toast in the browser
    if (method === "POST" && pathname === "/api/toast") {
      let body: { message?: string } = {};
      try {
        body = await req.json();
      } catch {
        return jsonResponse({ error: "Invalid JSON body" }, 400);
      }
      if (typeof body.message !== "string" || !body.message.trim()) {
        return jsonResponse({ error: "message required" }, 400);
      }
      if (broadcastToBrowsers) {
        broadcastToBrowsers(JSON.stringify({ type: "toast", message: body.message }));
      }
      return jsonResponse({ ok: true });
    }

    // GET /content/<topicId>/<filename> (0.4.0+) or /content/<filename>
    // (pre-0.4.0 fallback — served from the default topic dir after the
    // one-time migration in ensureRegistry).
    if (method === "GET" && pathname.startsWith("/content/")) {
      const rest = pathname.slice("/content/".length);
      if (rest.includes("..")) {
        return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
      }

      const parts = rest.split("/");
      let filePath: string;
      if (parts.length === 2) {
        const [topicId, filename] = parts;
        if (!isValidTopicId(topicId) || filename.includes("/")) {
          return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
        }
        filePath = join(topicContentDir(paths.root, topicId), filename);
      } else if (parts.length === 1) {
        const filename = parts[0];
        if (filename.includes("/")) {
          return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
        }
        filePath = join(topicContentDir(paths.root, DEFAULT_TOPIC_ID), filename);
      } else {
        return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
      }

      if (!existsSync(filePath)) {
        return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
      }
      return new Response(Bun.file(filePath), {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "text/html; charset=utf-8",
        },
      });
    }

    // Static files from publicDir
    const staticRoutes: Record<string, string> = {
      "/": "workspace.html",
      "/workspace.html": "workspace.html",
      "/styles.css": "styles.css",
      "/interactions.js": "interactions.js",
      "/iframe-bridge.js": "iframe-bridge.js",
    };

    if (method === "GET" && pathname in staticRoutes) {
      const filename = staticRoutes[pathname];
      const filePath = join(publicDir, filename);
      if (!existsSync(filePath)) {
        return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
      }
      return new Response(Bun.file(filePath), {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": contentTypeForExt(filename),
        },
      });
    }

    // 404 fallthrough
    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  };
}
