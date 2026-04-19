// server/topics.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdir, readdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  DEFAULT_TOPIC_ID,
  createTopic,
  ensureRegistry,
  isValidTopicId,
  readRegistry,
  setActiveTopic,
  slugify,
  topicContentDir,
} from "./topics";

let root: string;

async function freshRoot(): Promise<string> {
  const dir = join(tmpdir(), "forge-topics-" + Date.now() + "-" + Math.random());
  await mkdir(join(dir, "state"), { recursive: true });
  await mkdir(join(dir, "content"), { recursive: true });
  return dir;
}

beforeEach(async () => {
  root = await freshRoot();
});

describe("slug validation", () => {
  test("accepts canonical slugs", () => {
    expect(isValidTopicId("default")).toBe(true);
    expect(isValidTopicId("dashboard-ui")).toBe(true);
    expect(isValidTopicId("x1")).toBe(true);
  });

  test("rejects bad ids", () => {
    expect(isValidTopicId("")).toBe(false);
    expect(isValidTopicId("-leading")).toBe(false);
    expect(isValidTopicId("Upper")).toBe(false);
    expect(isValidTopicId("has space")).toBe(false);
    expect(isValidTopicId("../etc")).toBe(false);
    expect(isValidTopicId(null)).toBe(false);
    expect(isValidTopicId("a".repeat(65))).toBe(false);
  });
});

describe("slugify", () => {
  test("downcases and hyphenates", () => {
    expect(slugify("Provider Dashboard")).toBe("provider-dashboard");
  });
  test("strips trailing punctuation", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
  });
  test("falls back to default when empty result", () => {
    expect(slugify("!!!")).toBe(DEFAULT_TOPIC_ID);
  });
});

describe("ensureRegistry", () => {
  test("bootstraps a default topic when absent", async () => {
    const reg = await ensureRegistry(root);
    expect(reg.topics).toHaveLength(1);
    expect(reg.topics[0].id).toBe(DEFAULT_TOPIC_ID);
    expect(reg.activeId).toBe(DEFAULT_TOPIC_ID);
    expect(existsSync(topicContentDir(root, DEFAULT_TOPIC_ID))).toBe(true);
  });

  test("migrates legacy flat content into default topic", async () => {
    await writeFile(join(root, "content", "round-1-a.html"), "a");
    await writeFile(join(root, "content", "round-1-b.html"), "b");
    await writeFile(join(root, "content", "unrelated.txt"), "keep me");

    await ensureRegistry(root);

    const defaultFiles = await readdir(topicContentDir(root, DEFAULT_TOPIC_ID));
    expect(defaultFiles.sort()).toEqual(["round-1-a.html", "round-1-b.html"]);

    const top = await readdir(join(root, "content"));
    expect(top).toContain("unrelated.txt");
    expect(top).not.toContain("round-1-a.html");
  });

  test("is idempotent and preserves existing registry", async () => {
    const first = await ensureRegistry(root);
    await createTopic(root, { title: "Dashboard" });
    const again = await ensureRegistry(root);
    expect(again.topics.map((t) => t.id)).toEqual([
      first.topics[0].id,
      "dashboard",
    ]);
  });
});

describe("createTopic", () => {
  test("adds a topic, allocates its content dir, becomes active", async () => {
    await ensureRegistry(root);
    const result = await createTopic(root, { title: "Provider Dashboard" });
    expect(result.topic.id).toBe("provider-dashboard");
    expect(result.contentDir).toBe(topicContentDir(root, "provider-dashboard"));
    expect(existsSync(result.contentDir)).toBe(true);

    const reg = await readRegistry(root);
    expect(reg?.activeId).toBe("provider-dashboard");
  });

  test("honors an explicit id", async () => {
    await ensureRegistry(root);
    const result = await createTopic(root, { id: "custom", title: "X" });
    expect(result.topic.id).toBe("custom");
  });

  test("rejects invalid ids", async () => {
    await ensureRegistry(root);
    await expect(createTopic(root, { id: "BAD", title: "x" })).rejects.toThrow();
  });

  test("rejects duplicate ids", async () => {
    await ensureRegistry(root);
    await createTopic(root, { id: "dup", title: "one" });
    await expect(createTopic(root, { id: "dup", title: "two" })).rejects.toThrow();
  });

  test("persists prompt when provided", async () => {
    await ensureRegistry(root);
    const result = await createTopic(root, {
      title: "With prompt",
      prompt: "3 variations of a pricing page",
    });
    expect(result.topic.prompt).toBe("3 variations of a pricing page");
  });
});

describe("setActiveTopic", () => {
  test("updates the active id when the topic exists", async () => {
    await ensureRegistry(root);
    await createTopic(root, { id: "t2", title: "Two" });
    const reg = await setActiveTopic(root, DEFAULT_TOPIC_ID);
    expect(reg?.activeId).toBe(DEFAULT_TOPIC_ID);
  });

  test("returns null when the topic doesn't exist", async () => {
    await ensureRegistry(root);
    const reg = await setActiveTopic(root, "nope");
    expect(reg).toBeNull();
  });
});
