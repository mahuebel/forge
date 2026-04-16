import { appendFile, readFile } from "fs/promises";

// ─── Base event ────────────────────────────────────────────────────────────

export interface BaseEvent {
  type: string;
  seq: number;
  timestamp: number;
  replayed?: boolean;
}

// ─── Domain events ─────────────────────────────────────────────────────────

export interface SelectEvent extends BaseEvent {
  type: "select";
  variation: string;
  selector: string;
  label: string;
  action: "like" | "reject";
}

export interface AnnotateEvent extends BaseEvent {
  type: "annotate";
  variation: string;
  pin: number;
  position: { x: number; y: number };
  selector: string;
  text: string;
}

export interface VerdictEvent extends BaseEvent {
  type: "verdict";
  variation: string;
  action: "like" | "reject";
  reason?: string;
}

export interface RoundEvent extends BaseEvent {
  type: "round";
  round: number;
  variations: string[];
  prompt: string;
}

export interface HeartbeatEvent extends BaseEvent {
  type: "heartbeat";
  server_uptime_s: number;
  events_sent: number;
}

export type ForgeEvent =
  | SelectEvent
  | AnnotateEvent
  | VerdictEvent
  | RoundEvent
  | HeartbeatEvent;

// ─── JSONL utilities ───────────────────────────────────────────────────────

/**
 * Appends a single event as a JSON line to the given file.
 */
export async function appendEvent(filePath: string, event: ForgeEvent): Promise<void> {
  await appendFile(filePath, JSON.stringify(event) + "\n", "utf8");
}

/**
 * Reads and parses all events from a JSONL file.
 * Returns an empty array if the file does not exist or is empty.
 */
export async function readEvents(filePath: string): Promise<ForgeEvent[]> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ForgeEvent);
}

/**
 * Returns the number of event lines in a JSONL file.
 * Returns 0 if the file does not exist.
 */
export async function countEvents(filePath: string): Promise<number> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw err;
  }

  return content.split("\n").filter((line) => line.trim().length > 0).length;
}

/**
 * Creates a sequence counter closure.
 * @param startAfter - The counter will start issuing numbers after this value (default 0, so first call returns 1).
 */
export function createSequenceCounter(startAfter = 0): () => number {
  let current = startAfter;
  return () => ++current;
}
