import { join } from "path";
import { existsSync, readdirSync } from "fs";
import { appendEvent, readEvents, type ForgeEvent, type RoundEvent } from "./events";
import type { SessionPaths } from "./session";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RouteHandlerConfig {
  paths: SessionPaths;
  publicDir: string;
  getNextSeq: () => number;
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

const VALID_TYPES = new Set(["select", "annotate", "verdict", "refine"]);

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
  const { paths, publicDir, getNextSeq } = config;

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
      });
    }

    // GET /api/state
    if (method === "GET" && pathname === "/api/state") {
      const events = await readEvents(paths.eventsFile);

      // Sorted .html filenames in content dir
      let variations: string[] = [];
      if (existsSync(paths.content)) {
        variations = readdirSync(paths.content)
          .filter((f) => f.endsWith(".html"))
          .sort();
      }

      // Last round event's round number, or 0
      const lastRound = events
        .filter((e): e is RoundEvent => e.type === "round")
        .pop();
      const round = lastRound?.round ?? 0;

      return jsonResponse({ variations, round, eventCount: events.length });
    }

    // GET /api/events
    if (method === "GET" && pathname === "/api/events") {
      const events = await readEvents(paths.eventsFile);
      return jsonResponse(events);
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

      const event: ForgeEvent = {
        ...body,
        seq: getNextSeq(),
        timestamp: Date.now(),
      } as ForgeEvent;

      await appendEvent(paths.eventsFile, event);
      return jsonResponse(event, 201);
    }

    // GET /content/:filename
    if (method === "GET" && pathname.startsWith("/content/")) {
      const filename = pathname.slice("/content/".length);

      // Reject path traversal attempts
      if (filename.includes("..") || filename.includes("/")) {
        return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
      }

      const filePath = join(paths.content, filename);
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
