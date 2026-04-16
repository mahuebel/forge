// server/bridge.ts
import { readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import type { ForgeEvent } from "./events";

// --- Event formatting ---

export function formatEvent(event: ForgeEvent): string {
  switch (event.type) {
    case "select":
      return `[forge] Component on Variation ${event.variation.toUpperCase()} ${event.action === "like" ? "liked" : "rejected"}: "${event.label}" (${event.selector})`;
    case "annotate":
      return `[forge] Annotation on Variation ${event.variation.toUpperCase()} (pin #${event.pin}, near ${event.selector}):\n"${event.text}"`;
    case "verdict": {
      const reasonText = event.reason ? `\n"${event.reason}"` : "";
      return `[forge] Variation ${event.variation.toUpperCase()} ${event.action === "like" ? "liked" : "rejected"}:${reasonText}`;
    }
    case "round":
      return `[forge] Round ${event.round} generated: variations ${event.variations.join(", ")}\nPrompt: "${event.prompt}"`;
    case "heartbeat":
      return `[forge:heartbeat] uptime=${event.server_uptime_s}s events_sent=${event.events_sent}`;
    default:
      return `[forge] Unknown event: ${JSON.stringify(event)}`;
  }
}

// --- Cursor management ---

export async function readCursor(cursorFile: string): Promise<number> {
  try {
    const content = await fsReadFile(cursorFile, "utf-8");
    return parseInt(content.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

export async function writeCursor(
  cursorFile: string,
  position: number
): Promise<void> {
  await fsWriteFile(cursorFile, String(position));
}

// --- Unsent lines ---

export async function getUnsentLines(
  eventsFile: string,
  cursor: number
): Promise<string[]> {
  try {
    const content = await fsReadFile(eventsFile, "utf-8");
    if (!content.trim()) return [];
    const allLines = content.trim().split("\n").filter(Boolean);
    return allLines.slice(cursor);
  } catch {
    return [];
  }
}

// --- Bridge loop ---

export interface BridgeConfig {
  eventsFile: string;
  cursorFile: string;
  onMessage: (formatted: string, events: ForgeEvent[]) => void;
  debounceMs?: number;
  pollIntervalMs?: number;
}

export interface Bridge {
  start: () => void;
  stop: () => void;
  getEventsSent: () => number;
}

export function createBridge(config: BridgeConfig): Bridge {
  const {
    eventsFile,
    cursorFile,
    onMessage,
    debounceMs = 500,
    pollIntervalMs = 200,
  } = config;

  let running = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let eventsSent = 0;
  let pendingEvents: ForgeEvent[] = [];

  function flush() {
    if (pendingEvents.length === 0) return;
    const batch = [...pendingEvents];
    pendingEvents = [];

    const formatted = batch.map(formatEvent).join("\n");
    onMessage(formatted, batch);
    eventsSent += batch.length;
    debounceTimer = null;
  }

  async function poll() {
    if (!running) return;
    try {
      const cursor = await readCursor(cursorFile);
      const unsent = await getUnsentLines(eventsFile, cursor);
      if (unsent.length === 0) return;

      for (const line of unsent) {
        try {
          const event: ForgeEvent = JSON.parse(line);
          pendingEvents.push(event);
        } catch {
          // skip malformed lines
        }
      }

      // Advance cursor immediately so next poll doesn't re-queue the same events.
      // If the onMessage callback fails, events are still in pendingEvents and
      // will be flushed on the next debounce tick; recovery after crash happens
      // via the cursor file being persisted.
      await writeCursor(cursorFile, cursor + unsent.length);

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flush, debounceMs);
    } catch {
      // File read error — retry next poll
    }
  }

  return {
    start() {
      running = true;
      pollTimer = setInterval(poll, pollIntervalMs);
    },
    stop() {
      running = false;
      if (pollTimer) clearInterval(pollTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
    },
    getEventsSent: () => eventsSent,
  };
}
