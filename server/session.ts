import { mkdir, writeFile, readFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ─── Global active-sessions registry ─────────────────────────────────────────
// The channel server (separate process spawned by Claude Code via --channels)
// needs to discover HTTP servers running in various projects. Each HTTP server
// writes its server-info.json here on startup and removes it on shutdown.

export function getActiveSessionsDir(): string {
  return join(homedir(), ".claude", "forge", "active-sessions");
}

export function getActiveSessionFile(sessionId: string): string {
  return join(getActiveSessionsDir(), sessionId + ".json");
}

export async function registerActiveSession(
  sessionId: string,
  info: ServerInfo
): Promise<void> {
  const dir = getActiveSessionsDir();
  await mkdir(dir, { recursive: true });
  await writeFile(getActiveSessionFile(sessionId), JSON.stringify(info, null, 2));
}

export async function unregisterActiveSession(sessionId: string): Promise<void> {
  const path = getActiveSessionFile(sessionId);
  if (existsSync(path)) {
    try {
      await unlink(path);
    } catch {
      // best-effort
    }
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SessionPaths {
  root: string;
  content: string;
  state: string;
  bridge: string;
  eventsFile: string;
  pidFile: string;
  serverInfoFile: string;
  cursorFile: string;
}

export interface ServerInfo {
  port: number;
  url: string;
  sessionId: string;
  contentDir: string;
  eventsFile: string;
}

// ─── Path construction ───────────────────────────────────────────────────────

/**
 * Constructs all session-related paths under `{baseDir}/.forge/sessions/{sessionId}/`.
 */
export function getSessionPaths(baseDir: string, sessionId: string): SessionPaths {
  const root = join(baseDir, ".forge", "sessions", sessionId);
  const content = join(root, "content");
  const state = join(root, "state");
  const bridge = join(root, "bridge");

  return {
    root,
    content,
    state,
    bridge,
    eventsFile: join(state, "events.jsonl"),
    pidFile: join(state, "server.pid"),
    serverInfoFile: join(state, "server-info.json"),
    cursorFile: join(bridge, "cursor"),
  };
}

// ─── Session initialization ──────────────────────────────────────────────────

/**
 * Creates the session directory structure and initializes default files.
 * Idempotent: does not overwrite existing events file or cursor file.
 * Returns the SessionPaths for the created session.
 */
export async function createSession(baseDir: string, sessionId: string): Promise<SessionPaths> {
  const paths = getSessionPaths(baseDir, sessionId);

  // Create directories
  await mkdir(paths.content, { recursive: true });
  await mkdir(paths.state, { recursive: true });
  await mkdir(paths.bridge, { recursive: true });

  // Initialize events file only if it doesn't exist
  if (!existsSync(paths.eventsFile)) {
    await writeFile(paths.eventsFile, "", "utf8");
  }

  // Initialize cursor at "0" only if it doesn't exist
  if (!existsSync(paths.cursorFile)) {
    await writeFile(paths.cursorFile, "0", "utf8");
  }

  return paths;
}

// ─── PID file utilities ──────────────────────────────────────────────────────

/**
 * Writes the given PID as a string to the specified path.
 */
export async function writePidFile(pidPath: string, pid: number): Promise<void> {
  await writeFile(pidPath, String(pid), "utf8");
}

/**
 * Reads and parses the PID from the given path.
 * Returns null if the file does not exist.
 */
export async function readPidFile(pidPath: string): Promise<number | null> {
  try {
    const content = await readFile(pidPath, "utf8");
    return parseInt(content.trim(), 10);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Deletes the PID file if it exists. Does not throw if missing.
 */
export async function removePidFile(pidPath: string): Promise<void> {
  try {
    await unlink(pidPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }
}

// ─── Server info utilities ───────────────────────────────────────────────────

/**
 * Writes the ServerInfo object as JSON to the given path.
 */
export async function writeServerInfo(infoPath: string, info: ServerInfo): Promise<void> {
  await writeFile(infoPath, JSON.stringify(info, null, 2), "utf8");
}

/**
 * Reads and parses the ServerInfo from the given path.
 * Returns null if the file does not exist.
 */
export async function readServerInfo(infoPath: string): Promise<ServerInfo | null> {
  try {
    const content = await readFile(infoPath, "utf8");
    return JSON.parse(content) as ServerInfo;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}
