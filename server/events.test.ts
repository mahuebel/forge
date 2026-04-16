import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { rm, mkdir } from "fs/promises";
import type {
  SelectEvent,
  AnnotateEvent,
  VerdictEvent,
} from "./events";
import {
  appendEvent,
  readEvents,
  countEvents,
  createSequenceCounter,
} from "./events";

// ─── Type shape tests ──────────────────────────────────────────────────────

describe("SelectEvent", () => {
  test("has required fields", () => {
    const event: SelectEvent = {
      type: "select",
      seq: 1,
      variation: "v1",
      selector: "#hero",
      label: "Hero section",
      action: "like",
      timestamp: Date.now(),
    };
    expect(event.type).toBe("select");
    expect(event.seq).toBe(1);
    expect(event.variation).toBe("v1");
    expect(event.selector).toBe("#hero");
    expect(event.label).toBe("Hero section");
    expect(event.action).toBe("like");
    expect(typeof event.timestamp).toBe("number");
  });

  test("action can be reject", () => {
    const event: SelectEvent = {
      type: "select",
      seq: 2,
      variation: "v2",
      selector: ".card",
      label: "Card",
      action: "reject",
      timestamp: Date.now(),
    };
    expect(event.action).toBe("reject");
  });
});

describe("AnnotateEvent", () => {
  test("has position as percentage (x/y between 0 and 1)", () => {
    const event: AnnotateEvent = {
      type: "annotate",
      seq: 3,
      variation: "v1",
      pin: 1,
      position: { x: 0.25, y: 0.75 },
      selector: ".header",
      text: "Move this up",
      timestamp: Date.now(),
    };
    expect(event.position.x).toBeGreaterThanOrEqual(0);
    expect(event.position.x).toBeLessThanOrEqual(1);
    expect(event.position.y).toBeGreaterThanOrEqual(0);
    expect(event.position.y).toBeLessThanOrEqual(1);
    expect(event.position.x).toBe(0.25);
    expect(event.position.y).toBe(0.75);
    expect(typeof event.pin).toBe("number");
  });
});

describe("VerdictEvent", () => {
  test("accepts optional reason", () => {
    const withReason: VerdictEvent = {
      type: "verdict",
      seq: 4,
      variation: "v1",
      action: "like",
      timestamp: Date.now(),
      reason: "Best contrast ratio",
    };
    expect(withReason.reason).toBe("Best contrast ratio");

    const withoutReason: VerdictEvent = {
      type: "verdict",
      seq: 5,
      variation: "v2",
      action: "reject",
      timestamp: Date.now(),
    };
    expect(withoutReason.reason).toBeUndefined();
  });
});

// ─── JSONL utility tests ───────────────────────────────────────────────────

let tmpDir: string;
let filePath: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `events-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });
  filePath = join(tmpDir, "events.jsonl");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("appendEvent", () => {
  test("writes one line per event to JSONL file", async () => {
    const e1: SelectEvent = {
      type: "select",
      seq: 1,
      variation: "v1",
      selector: "#btn",
      label: "Button",
      action: "like",
      timestamp: 1704067200000,
    };
    const e2: SelectEvent = {
      type: "select",
      seq: 2,
      variation: "v2",
      selector: "#link",
      label: "Link",
      action: "reject",
      timestamp: 1704067201000,
    };

    await appendEvent(filePath, e1);
    await appendEvent(filePath, e2);

    const lines = (await readEvents(filePath));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ type: "select", seq: 1 });
    expect(lines[1]).toMatchObject({ type: "select", seq: 2 });
  });
});

describe("readEvents", () => {
  test("returns empty array for missing file", async () => {
    const missing = join(tmpDir, "nonexistent.jsonl");
    const result = await readEvents(missing);
    expect(result).toEqual([]);
  });

  test("parses all events from file", async () => {
    const events: SelectEvent[] = [
      { type: "select", seq: 1, variation: "v1", selector: "#a", label: "A", action: "like", timestamp: 1 },
      { type: "select", seq: 2, variation: "v2", selector: "#b", label: "B", action: "reject", timestamp: 2 },
      { type: "select", seq: 3, variation: "v1", selector: "#c", label: "C", action: "like", timestamp: 3 },
    ];

    for (const ev of events) {
      await appendEvent(filePath, ev);
    }

    const parsed = await readEvents(filePath);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({ seq: 1, variation: "v1" });
    expect(parsed[1]).toMatchObject({ seq: 2, variation: "v2" });
    expect(parsed[2]).toMatchObject({ seq: 3, variation: "v1" });
  });
});

describe("countEvents", () => {
  test("returns line count", async () => {
    const e: SelectEvent = {
      type: "select",
      seq: 1,
      variation: "v1",
      selector: "#x",
      label: "X",
      action: "like",
      timestamp: 1,
    };

    expect(await countEvents(filePath)).toBe(0);
    await appendEvent(filePath, e);
    expect(await countEvents(filePath)).toBe(1);
    await appendEvent(filePath, { ...e, seq: 2 });
    expect(await countEvents(filePath)).toBe(2);
  });
});

describe("createSequenceCounter", () => {
  test("starts at 1 and increments", () => {
    const next = createSequenceCounter();
    expect(next()).toBe(1);
    expect(next()).toBe(2);
    expect(next()).toBe(3);
  });

  test("can start from a given value", () => {
    const next = createSequenceCounter(10);
    expect(next()).toBe(11);
    expect(next()).toBe(12);
  });
});
