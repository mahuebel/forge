import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtempSync, writeFileSync } from "fs";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { createSession } from "./session";
import { createSequenceCounter } from "./events";
import { createRouteHandler } from "./routes";
import { DEFAULT_TOPIC_ID, ensureRegistry, topicContentDir } from "./topics";

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
    await ensureRegistry(paths.root);
    const getNextSeq = createSequenceCounter(0);
    const publicDir = join(import.meta.dir, "public");
    const handler = createRouteHandler({
      paths,
      publicDir,
      getNextSeq,
      pluginVersion: "9.9.9-test",
    });
    server = await startServer(handler);
  });

  afterEach(async () => {
    await server.stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── GET /health ────────────────────────────────────────────────────────

  test("GET /health returns 200 with status ok and uptime_s", async () => {
    const res = await fetch(`http://localhost:${server.port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime_s).toBe("number");
  });

  test("GET /health includes the plugin version", async () => {
    const res = await fetch(`http://localhost:${server.port}/health`);
    const body = await res.json();
    expect(body.version).toBe("9.9.9-test");
  });

  // ─── GET /api/state ─────────────────────────────────────────────────────

  test("GET /api/state returns 200 with empty state for new session", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/state`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.variations).toEqual([]);
    expect(body.round).toBe(0);
    expect(typeof body.eventCount).toBe("number");
  });

  // ─── GET /api/events ────────────────────────────────────────────────────

  test("GET /api/events returns 200 with empty array for new session", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/events`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  // ─── POST /api/events ───────────────────────────────────────────────────

  test("POST /api/events returns 201 with seq=1, type, and timestamp", async () => {
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

  test("POST /api/events second call returns seq=2", async () => {
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

  test("POST /api/events with invalid type returns 400", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "invalid" }),
    });
    expect(res.status).toBe(400);
  });

  // ─── GET /content/:filename ─────────────────────────────────────────────

  test("GET /content/:filename (flat, legacy) serves from default topic dir", async () => {
    const filename = "variation-a.html";
    const defaultDir = topicContentDir(paths.root, DEFAULT_TOPIC_ID);
    writeFileSync(join(defaultDir, filename), "<html>variation a</html>", "utf8");

    const res = await fetch(`http://localhost:${server.port}/content/${filename}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("variation a");
  });

  test("GET /content/<topicId>/<filename> serves from the topic's dir", async () => {
    const filename = "round-1-a.html";
    const dir = topicContentDir(paths.root, DEFAULT_TOPIC_ID);
    writeFileSync(join(dir, filename), "<html>topic served</html>", "utf8");

    const res = await fetch(
      `http://localhost:${server.port}/content/${DEFAULT_TOPIC_ID}/${filename}`
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("topic served");
  });

  test("GET /content/:filename returns 404 for missing file", async () => {
    const res = await fetch(`http://localhost:${server.port}/content/nonexistent.html`);
    expect(res.status).toBe(404);
  });

  test("GET /content/:filename rejects path traversal with 403", async () => {
    const res = await fetch(`http://localhost:${server.port}/content/..%2Fetc%2Fpasswd`);
    expect(res.status).toBe(403);
  });

  // ─── Topics ──────────────────────────────────────────────────────────────

  test("GET /api/topics returns the bootstrapped default topic", async () => {
    const res = await fetch(`http://localhost:${server.port}/api/topics`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activeId).toBe(DEFAULT_TOPIC_ID);
    expect(body.topics).toHaveLength(1);
    expect(body.topics[0].id).toBe(DEFAULT_TOPIC_ID);
  });

  test("POST /api/topics creates a topic and scopes state/events to it", async () => {
    const createRes = await fetch(`http://localhost:${server.port}/api/topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Provider Dashboard" }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.topic.id).toBe("provider-dashboard");

    // Post an event without topic_id — it should land on the active topic
    // (which createTopic just set to the new one).
    await fetch(`http://localhost:${server.port}/api/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "verdict", variation: "a", action: "like" }),
    });

    const defaultStateRes = await fetch(
      `http://localhost:${server.port}/api/state?topic=${DEFAULT_TOPIC_ID}`
    );
    const defaultState = await defaultStateRes.json();
    expect(defaultState.eventCount).toBe(0);

    const scopedRes = await fetch(
      `http://localhost:${server.port}/api/state?topic=provider-dashboard`
    );
    const scoped = await scopedRes.json();
    expect(scoped.eventCount).toBe(1);
  });

  test("POST /api/topics rejects duplicate ids with 409", async () => {
    await fetch(`http://localhost:${server.port}/api/topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "dup", title: "one" }),
    });
    const res = await fetch(`http://localhost:${server.port}/api/topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "dup", title: "two" }),
    });
    expect(res.status).toBe(409);
  });

  test("POST /api/topics/active switches the active topic", async () => {
    await fetch(`http://localhost:${server.port}/api/topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "t2", title: "Two" }),
    });
    const res = await fetch(`http://localhost:${server.port}/api/topics/active`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: DEFAULT_TOPIC_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activeId).toBe(DEFAULT_TOPIC_ID);
  });
});
