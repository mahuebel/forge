#!/usr/bin/env bun
// shutdown-forge-server.ts
//
// SessionEnd hook for the forge plugin.
//
// When a Claude Code session ends cleanly, look up any forge servers
// owned by this Claude process (matched via the claudePid field in the
// global active-sessions registry) and send them SIGTERM so ports free
// up immediately.
//
// The server itself also runs an orphan watchdog that polls its owning
// pid every 10s — this hook just makes the cleanup faster on a clean
// exit. If the hook fails or doesn't fire (Claude crash, kill -9), the
// watchdog still wins eventually.
//
// Output: silent. No additionalContext is meaningful for SessionEnd.

import { readdirSync, readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const ppid = process.ppid;
const registryDir = join(homedir(), ".claude", "forge", "active-sessions");

if (!existsSync(registryDir)) process.exit(0);

let entries: string[] = [];
try {
  entries = readdirSync(registryDir).filter((f) => f.endsWith(".json"));
} catch {
  process.exit(0);
}

for (const entry of entries) {
  const path = join(registryDir, entry);
  let info: { claudePid?: number; sessionId?: string; port?: number } = {};
  try {
    info = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    continue;
  }
  if (info.claudePid !== ppid) continue;

  const serverPid = (info as { serverPid?: number }).serverPid;
  if (typeof serverPid !== "number") continue;

  try {
    process.kill(serverPid, "SIGTERM");
  } catch {
    // Already dead — fine.
  }
}

process.exit(0);
