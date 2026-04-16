import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { createSession } from "./session";
import { createSequenceCounter } from "./events";
import { createRouteHandler } from "./routes";

// ─── Helpers ────────────────────────────────────────────────────────────────

async function startServer(handler: (req: Request) => Promise<Response>) {
  return Bun.serve({ port: 0, fetch: handler });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("HTTP routes", () => {
  let tempDir: string;
  let paths: Awaited<ReturnType<typeof createSession>>;
  let server: ReturnType<typeof Bun.serve>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "forge-routes-test-"));
    paths = await createSession(tempDir, "test-session");
    const getNextSeq = createSequenceCounter(0);
    const publicDir = join(import.meta.dir, "public");
    const handler = createRouteHandler({ paths, publicDir, getNextSeq });
    server = await startServer(handler);
  });

  afterEach(async () => {
    await server.stop();
  });

  // ─── GET /health ────────────────────────────────────────────────────────

  it("GET /health returns 200 with status ok and uptime_s", async () => {
    const res = await fetch(`http://localhost:${server.port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime_s).toBe("number");
  });

  // ─── GET /api/state ─────────────────────────────────────────────────────

  it("GET /api/state returns 200 with empty state for new session", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/state`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.variations).toEqual([]);
    expect(body.round).toBe(0);
    expect(typeof body.eventCount).toBe("number");
  });

  // ─── GET /api/events ────────────────────────────────────────────────────

  it("GET /api/events returns 200 with empty array for new session", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/events`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  // ─── POST /api/events ───────────────────────────────────────────────────

  it("POST /api/events returns 201 with seq=1, type, and timestamp", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "verdict", variation: "a", action: "like" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.seq).toBe(1);
    expect(body.type).toBe("verdict");
    expect(typeof body.timestamp).toBe("number");
  });

  it("POST /api/events second call returns seq=2", async () => {
    await fetch(`http://localhost:${server.port}/api/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "verdict", variation: "a", action: "like" }),
    });
    const res = await fetch(`http://localhost:${server.port}/api/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "verdict", variation: "b", action: "reject" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.seq).toBe(2);
  });

  it("POST /api/events with invalid type returns 400", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "invalid" }),
    });
    expect(res.status).toBe(400);
  });

  // ─── GET /content/:filename ─────────────────────────────────────────────

  it("GET /content/:filename serves an HTML file from content dir", async () => {
    const filename = "variation-a.html";
    writeFileSync(join(paths.content, filename), "<html>variation a</html>", "utf8");

    const res = await fetch(`http://localhost:${server.port}/content/${filename}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("variation a");
  });

  it("GET /content/:filename returns 404 for missing file", async () => {
    const res = await fetch(`http://localhost:${server.port}/content/nonexistent.html`);
    expect(res.status).toBe(404);
  });
});
