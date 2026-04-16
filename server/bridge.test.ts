import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtemp, rm, writeFile } from "fs/promises";
import {
  formatEvent,
  readCursor,
  writeCursor,
  getUnsentLines,
  createBridge,
} from "./bridge";
import type { SelectEvent, VerdictEvent, AnnotateEvent, ForgeEvent } from "./events";
import { appendFile } from "fs/promises";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ─── formatEvent ──────────────────────────────────────────────────────────────

describe("formatEvent", () => {
  test("formats select event", () => {
    const event: SelectEvent = {
      type: "select",
      seq: 1,
      timestamp: Date.now(),
      variation: "a",
      selector: ".stat-card",
      label: "Revenue card",
      action: "like",
    };
    const result = formatEvent(event);
    expect(result).toContain("[forge]");
    expect(result).toContain("Variation A");
    expect(result).toContain("Revenue card");
    expect(result).toContain("liked");
  });

  test("formats verdict event with reason", () => {
    const event: VerdictEvent = {
      type: "verdict",
      seq: 2,
      timestamp: Date.now(),
      variation: "c",
      action: "reject",
      reason: "Too minimal",
    };
    const result = formatEvent(event);
    expect(result).toContain("Variation C rejected");
    expect(result).toContain("Too minimal");
  });

  test("formats annotate event", () => {
    const event: AnnotateEvent = {
      type: "annotate",
      seq: 3,
      timestamp: Date.now(),
      variation: "b",
      pin: 2,
      position: { x: 100, y: 200 },
      selector: ".chart",
      text: "Needs a legend",
    };
    const result = formatEvent(event);
    expect(result).toContain("pin #2");
    expect(result).toContain("Needs a legend");
  });
});

// ─── Cursor management ────────────────────────────────────────────────────────

describe("cursor management", () => {
  test("readCursor returns 0 for new file", async () => {
    const cursorFile = join(dir, "cursor.txt");
    await writeFile(cursorFile, "0");
    const result = await readCursor(cursorFile);
    expect(result).toBe(0);
  });

  test("writeCursor and readCursor round-trip", async () => {
    const cursorFile = join(dir, "cursor.txt");
    await writeCursor(cursorFile, 42);
    const result = await readCursor(cursorFile);
    expect(result).toBe(42);
  });
});

// ─── getUnsentLines ───────────────────────────────────────────────────────────

describe("getUnsentLines", () => {
  test("returns lines after cursor", async () => {
    const eventsFile = join(dir, "events.jsonl");
    const lines = [
      JSON.stringify({ seq: 1, type: "heartbeat" }),
      JSON.stringify({ seq: 2, type: "heartbeat" }),
      JSON.stringify({ seq: 3, type: "heartbeat" }),
    ];
    await writeFile(eventsFile, lines.join("\n") + "\n");
    const result = await getUnsentLines(eventsFile, 1);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('"seq":2');
    expect(result[1]).toContain('"seq":3');
  });

  test("returns empty for cursor at end", async () => {
    const eventsFile = join(dir, "events.jsonl");
    await writeFile(eventsFile, JSON.stringify({ seq: 1, type: "heartbeat" }) + "\n");
    const result = await getUnsentLines(eventsFile, 1);
    expect(result).toEqual([]);
  });

  test("returns all lines for cursor at 0", async () => {
    const eventsFile = join(dir, "events.jsonl");
    const lines = [
      JSON.stringify({ seq: 1, type: "heartbeat" }),
      JSON.stringify({ seq: 2, type: "heartbeat" }),
    ];
    await writeFile(eventsFile, lines.join("\n") + "\n");
    const result = await getUnsentLines(eventsFile, 0);
    expect(result).toHaveLength(2);
  });
});

// ─── createBridge integration ────────────────────────────────────────────────

describe("createBridge", () => {
  test("forwards newly-appended events via onMessage after debounce", async () => {
    const eventsFile = join(dir, "events.jsonl");
    const cursorFile = join(dir, "cursor");
    await writeFile(eventsFile, "");
    await writeFile(cursorFile, "0");

    const messages: string[] = [];
    const batches: ForgeEvent[][] = [];
    const bridge = createBridge({
      eventsFile,
      cursorFile,
      onMessage: (formatted, events) => {
        messages.push(formatted);
        batches.push(events);
      },
      debounceMs: 100,
      pollIntervalMs: 40,
    });

    bridge.start();

    // Append a verdict event
    const e: VerdictEvent = {
      type: "verdict",
      seq: 1,
      variation: "a",
      action: "like",
      timestamp: Date.now(),
    };
    await appendFile(eventsFile, JSON.stringify(e) + "\n");

    // Wait for poll + debounce to fire
    await new Promise((r) => setTimeout(r, 400));
    bridge.stop();

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Variation A liked");
    expect(batches[0]).toHaveLength(1);
    expect(bridge.getEventsSent()).toBe(1);

    // Cursor should be advanced to 1
    const cursor = await readCursor(cursorFile);
    expect(cursor).toBe(1);
  });

  test("does not re-queue events across polls (advances cursor immediately)", async () => {
    const eventsFile = join(dir, "events.jsonl");
    const cursorFile = join(dir, "cursor");
    await writeFile(eventsFile, "");
    await writeFile(cursorFile, "0");

    const messages: string[] = [];
    const bridge = createBridge({
      eventsFile,
      cursorFile,
      onMessage: (formatted) => { messages.push(formatted); },
      debounceMs: 200, // long enough that multiple polls run before flush
      pollIntervalMs: 30,
    });

    bridge.start();

    const e: VerdictEvent = {
      type: "verdict",
      seq: 1,
      variation: "b",
      action: "reject",
      timestamp: Date.now(),
    };
    await appendFile(eventsFile, JSON.stringify(e) + "\n");

    // Wait longer than debounce, so multiple polls run
    await new Promise((r) => setTimeout(r, 500));
    bridge.stop();

    expect(messages).toHaveLength(1);
    expect(bridge.getEventsSent()).toBe(1);
  });
});
