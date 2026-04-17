import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { rm, mkdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import type { SessionPaths, ServerInfo } from "./session";
import {
  getSessionPaths,
  createSession,
  writePidFile,
  readPidFile,
  removePidFile,
  writeServerInfo,
  readServerInfo,
} from "./session";

// ─── Test fixtures ─────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(
    tmpdir(),
    `session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── getSessionPaths ────────────────────────────────────────────────────────

describe("getSessionPaths", () => {
  test("returns correct directory structure", () => {
    const paths = getSessionPaths(tmpDir, "abc123");

    const sessionRoot = join(tmpDir, ".forge", "sessions", "abc123");

    expect(paths.root).toBe(sessionRoot);
    expect(paths.content).toBe(join(sessionRoot, "content"));
    expect(paths.state).toBe(join(sessionRoot, "state"));
    expect(paths.bridge).toBe(join(sessionRoot, "bridge"));
    expect(paths.eventsFile).toBe(join(sessionRoot, "state", "events.jsonl"));
    expect(paths.pidFile).toBe(join(sessionRoot, "state", "server.pid"));
    expect(paths.serverInfoFile).toBe(join(sessionRoot, "state", "server-info.json"));
    expect(paths.cursorFile).toBe(join(sessionRoot, "bridge", "cursor"));
  });

  test("uses the provided sessionId in all paths", () => {
    const paths1 = getSessionPaths(tmpDir, "session-1");
    const paths2 = getSessionPaths(tmpDir, "session-2");

    expect(paths1.root).toContain("session-1");
    expect(paths2.root).toContain("session-2");
    expect(paths1.root).not.toBe(paths2.root);
  });

  test("all paths are nested under baseDir", () => {
    const paths = getSessionPaths(tmpDir, "xyz");

    expect(paths.root.startsWith(tmpDir)).toBe(true);
    expect(paths.content.startsWith(tmpDir)).toBe(true);
    expect(paths.state.startsWith(tmpDir)).toBe(true);
    expect(paths.bridge.startsWith(tmpDir)).toBe(true);
    expect(paths.eventsFile.startsWith(tmpDir)).toBe(true);
    expect(paths.pidFile.startsWith(tmpDir)).toBe(true);
    expect(paths.serverInfoFile.startsWith(tmpDir)).toBe(true);
    expect(paths.cursorFile.startsWith(tmpDir)).toBe(true);
  });
});

// ─── createSession ──────────────────────────────────────────────────────────

describe("createSession", () => {
  test("creates all required directories", async () => {
    await createSession(tmpDir, "sess-001");

    const paths = getSessionPaths(tmpDir, "sess-001");

    expect(existsSync(paths.content)).toBe(true);
    expect(existsSync(paths.state)).toBe(true);
    expect(existsSync(paths.bridge)).toBe(true);
  });

  test("initializes empty events file", async () => {
    await createSession(tmpDir, "sess-001");

    const paths = getSessionPaths(tmpDir, "sess-001");
    expect(existsSync(paths.eventsFile)).toBe(true);

    const content = await readFile(paths.eventsFile, "utf8");
    expect(content).toBe("");
  });

  test("initializes cursor at '0'", async () => {
    await createSession(tmpDir, "sess-001");

    const paths = getSessionPaths(tmpDir, "sess-001");
    expect(existsSync(paths.cursorFile)).toBe(true);

    const content = await readFile(paths.cursorFile, "utf8");
    expect(content).toBe("0");
  });

  test("returns SessionPaths", async () => {
    const paths = await createSession(tmpDir, "sess-001");

    expect(paths.root).toBeDefined();
    expect(paths.content).toBeDefined();
    expect(paths.state).toBeDefined();
    expect(paths.bridge).toBeDefined();
    expect(paths.eventsFile).toBeDefined();
    expect(paths.pidFile).toBeDefined();
    expect(paths.serverInfoFile).toBeDefined();
    expect(paths.cursorFile).toBeDefined();
  });

  test("is idempotent — does not overwrite existing events file", async () => {
    await createSession(tmpDir, "sess-001");

    const paths = getSessionPaths(tmpDir, "sess-001");

    // Write data to events file
    await writeFile(paths.eventsFile, '{"type":"heartbeat"}\n', "utf8");

    // Call createSession again
    await createSession(tmpDir, "sess-001");

    // Events file should still have original content
    const content = await readFile(paths.eventsFile, "utf8");
    expect(content).toBe('{"type":"heartbeat"}\n');
  });

  test("is idempotent — does not overwrite existing cursor file", async () => {
    await createSession(tmpDir, "sess-001");

    const paths = getSessionPaths(tmpDir, "sess-001");

    // Advance cursor
    await writeFile(paths.cursorFile, "42", "utf8");

    // Call createSession again
    await createSession(tmpDir, "sess-001");

    // Cursor should remain at 42
    const content = await readFile(paths.cursorFile, "utf8");
    expect(content).toBe("42");
  });
});

// ─── PID file ───────────────────────────────────────────────────────────────

describe("PID file", () => {
  test("writePidFile + readPidFile round-trip", async () => {
    const pidPath = join(tmpDir, "server.pid");
    await writePidFile(pidPath, 12345);
    const pid = await readPidFile(pidPath);
    expect(pid).toBe(12345);
  });

  test("readPidFile returns null for missing file", async () => {
    const pidPath = join(tmpDir, "nonexistent.pid");
    const result = await readPidFile(pidPath);
    expect(result).toBeNull();
  });

  test("removePidFile deletes the file", async () => {
    const pidPath = join(tmpDir, "server.pid");
    await writePidFile(pidPath, 99999);
    expect(existsSync(pidPath)).toBe(true);

    await removePidFile(pidPath);
    expect(existsSync(pidPath)).toBe(false);
  });

  test("removePidFile does not throw if file is missing", async () => {
    const pidPath = join(tmpDir, "nonexistent.pid");
    await expect(removePidFile(pidPath)).resolves.toBeUndefined();
  });
});

// ─── Server info ────────────────────────────────────────────────────────────

describe("server info", () => {
  test("writeServerInfo + readServerInfo round-trip", async () => {
    const infoPath = join(tmpDir, "server-info.json");
    const info: ServerInfo = {
      port: 3000,
      url: "http://localhost:3000",
      sessionId: "abc123",
      contentDir: "/some/path/content",
      eventsFile: "/some/path/state/events.jsonl",
    };

    await writeServerInfo(infoPath, info);
    const result = await readServerInfo(infoPath);

    expect(result).toEqual(info);
  });

  test("readServerInfo returns null for missing file", async () => {
    const infoPath = join(tmpDir, "nonexistent.json");
    const result = await readServerInfo(infoPath);
    expect(result).toBeNull();
  });

  test("ServerInfo has expected fields", async () => {
    const infoPath = join(tmpDir, "server-info.json");
    const info: ServerInfo = {
      port: 8080,
      url: "http://localhost:8080",
      sessionId: "test-session",
      contentDir: "/base/.forge/sessions/test-session/content",
      eventsFile: "/base/.forge/sessions/test-session/state/events.jsonl",
    };

    await writeServerInfo(infoPath, info);
    const result = await readServerInfo(infoPath);

    expect(result?.port).toBe(8080);
    expect(result?.url).toBe("http://localhost:8080");
    expect(result?.sessionId).toBe("test-session");
    expect(result?.contentDir).toBe("/base/.forge/sessions/test-session/content");
    expect(result?.eventsFile).toBe("/base/.forge/sessions/test-session/state/events.jsonl");
  });

  test("claudePid round-trips through server-info", async () => {
    const infoPath = join(tmpDir, "server-info.json");
    const info: ServerInfo = {
      port: 4546,
      url: "http://localhost:4546",
      sessionId: "forge-owned",
      contentDir: "/base/content",
      eventsFile: "/base/events.jsonl",
      version: "0.3.3",
      claudePid: 98765,
    };

    await writeServerInfo(infoPath, info);
    const result = await readServerInfo(infoPath);

    expect(result?.claudePid).toBe(98765);
    expect(result?.version).toBe("0.3.3");
  });

  test("claudePid is optional for legacy compatibility", async () => {
    const infoPath = join(tmpDir, "server-info.json");
    const info: ServerInfo = {
      port: 4546,
      url: "http://localhost:4546",
      sessionId: "forge-legacy",
      contentDir: "/base/content",
      eventsFile: "/base/events.jsonl",
    };

    await writeServerInfo(infoPath, info);
    const result = await readServerInfo(infoPath);

    expect(result?.claudePid).toBeUndefined();
  });
});
