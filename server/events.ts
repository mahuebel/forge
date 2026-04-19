import { appendFile, readFile } from "fs/promises";

// ─── Base event ────────────────────────────────────────────────────────────

export interface BaseEvent {
  type: string;
  seq: number;
  timestamp: number;
  replayed?: boolean;
  /** Topic this event belongs to within the session. Added in 0.4.0 so a
   * single server can host many concurrent `/forge` workspaces. Events
   * written before topics were introduced omit this field; consumers
   * should treat a missing value as the "default" topic. */
  topic_id?: string;
}

// ─── Domain events ─────────────────────────────────────────────────────────

export interface SelectEvent extends BaseEvent {
  type: "select";
  variation: string;
  selector: string;
  label: string;
  action: "like" | "reject";
  /** Round this event belongs to. Added in 0.3.4 so the workspace UI can
   * scope verdicts/annotations/selects to the current round without
   * relying on in-order replay of the round reset event. Optional for
   * backward compatibility with events written before this field existed. */
  round?: number;
}

export interface AnnotateEvent extends BaseEvent {
  type: "annotate";
  variation: string;
  pin: number;
  /** Click position as a fraction (0..1) of the overlay container.
   * Retained as a fallback for rendering when `selector` can't be
   * resolved against the current iframe document. */
  position: { x: number; y: number };
  selector: string;
  text: string;
  /** See SelectEvent.round. */
  round?: number;
  /** Click offset within the resolved element, as fractions of the
   * element's bounding box. Added in 0.3.4 so pins can re-anchor to the
   * clicked element when the iframe reflows (e.g. on Grid↔Full view
   * switch, which resizes the iframe and re-lays out the content). */
  offset?: { fx: number; fy: number };
  /** "point" (default/legacy, single pin) or "area" (drag-selected region).
   * "general" reserved for batch 4 — notes with no spatial anchor. */
  shape?: "point" | "area" | "general";
  /** For shape === "area": the selected region as fractions (0..1) of the
   * iframe's content dimensions at drag time. Rendered by mapping to
   * current content dimensions, so areas track reflow proportionally. */
  bounds?: { x: number; y: number; w: number; h: number };
}

export interface VerdictEvent extends BaseEvent {
  type: "verdict";
  variation: string;
  action: "like" | "reject";
  reason?: string;
  /** See SelectEvent.round. */
  round?: number;
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

export interface RefineEvent extends BaseEvent {
  type: "refine";
  note?: string;
}

export type ForgeEvent =
  | SelectEvent
  | AnnotateEvent
  | VerdictEvent
  | RoundEvent
  | HeartbeatEvent
  | RefineEvent;

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
