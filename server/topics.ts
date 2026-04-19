// server/topics.ts
//
// Topic registry for the forge workspace. A single Claude session runs
// one server, which can host many `/forge` invocations side-by-side —
// each one is a "topic" with its own rounds, variations, and prompt.
// Events all live in a single `state/events.jsonl` tagged by `topic_id`;
// content files are nested under `content/<topicId>/`.
//
// This module owns the `state/topics.json` registry and the filesystem
// layout: directory creation, legacy migration, slug validation.

import { mkdir, readFile, writeFile, readdir, rename } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

export interface Topic {
  id: string;
  title: string;
  createdAt: number;
  /** Optional initial prompt used to generate the first round. Not
   * authoritative — the `prompt` field on round events is what the UI
   * actually displays. */
  prompt?: string;
}

export interface TopicRegistry {
  topics: Topic[];
  activeId: string;
}

export const DEFAULT_TOPIC_ID = "default";

// Slug rules: lowercase alphanumerics and hyphens, 1–64 chars, must start
// with alnum. Matches common URL-slug conventions. Used both for POST
// body validation and for content-path traversal safety.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidTopicId(id: unknown): id is string {
  return typeof id === "string" && SLUG_RE.test(id);
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || DEFAULT_TOPIC_ID;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

export function topicsFilePath(sessionRoot: string): string {
  return join(sessionRoot, "state", "topics.json");
}

export function topicContentDir(sessionRoot: string, topicId: string): string {
  return join(sessionRoot, "content", topicId);
}

// ─── Registry I/O ──────────────────────────────────────────────────────────

export async function readRegistry(
  sessionRoot: string
): Promise<TopicRegistry | null> {
  const path = topicsFilePath(sessionRoot);
  if (!existsSync(path)) return null;
  const content = await readFile(path, "utf-8");
  return JSON.parse(content) as TopicRegistry;
}

export async function writeRegistry(
  sessionRoot: string,
  registry: TopicRegistry
): Promise<void> {
  const path = topicsFilePath(sessionRoot);
  await writeFile(path, JSON.stringify(registry, null, 2), "utf-8");
}

// ─── Bootstrap ─────────────────────────────────────────────────────────────

/**
 * Ensures `state/topics.json` exists with at least the default topic, and
 * migrates any legacy flat-layout content (round-*.html directly under
 * `content/`) into `content/default/`. Idempotent.
 */
export async function ensureRegistry(
  sessionRoot: string
): Promise<TopicRegistry> {
  const existing = await readRegistry(sessionRoot);
  if (existing && existing.topics.length > 0) {
    // Ensure every known topic has its content dir.
    for (const t of existing.topics) {
      await mkdir(topicContentDir(sessionRoot, t.id), { recursive: true });
    }
    return existing;
  }

  const registry: TopicRegistry = {
    topics: [
      {
        id: DEFAULT_TOPIC_ID,
        title: "Default",
        createdAt: Date.now(),
      },
    ],
    activeId: DEFAULT_TOPIC_ID,
  };

  await mkdir(topicContentDir(sessionRoot, DEFAULT_TOPIC_ID), {
    recursive: true,
  });
  await migrateLegacyContent(sessionRoot);
  await writeRegistry(sessionRoot, registry);
  return registry;
}

/**
 * Moves any `content/round-*.html` files written by a pre-0.4.0 server
 * into `content/default/`. No-op if the session is already topic-layout.
 */
async function migrateLegacyContent(sessionRoot: string): Promise<void> {
  const contentDir = join(sessionRoot, "content");
  if (!existsSync(contentDir)) return;

  const entries = await readdir(contentDir, { withFileTypes: true });
  const legacy = entries.filter(
    (e) => e.isFile() && /^round-\d+-[a-z]\.html$/.test(e.name)
  );
  if (legacy.length === 0) return;

  const destDir = topicContentDir(sessionRoot, DEFAULT_TOPIC_ID);
  await mkdir(destDir, { recursive: true });
  for (const e of legacy) {
    await rename(join(contentDir, e.name), join(destDir, e.name));
  }
}

// ─── Mutations ─────────────────────────────────────────────────────────────

export interface CreateTopicRequest {
  id?: string;
  title: string;
  prompt?: string;
}

export interface CreateTopicResult {
  topic: Topic;
  contentDir: string;
}

/**
 * Creates a new topic in the registry, allocates its content directory,
 * and marks it active. Throws if the id is invalid or already exists.
 */
export async function createTopic(
  sessionRoot: string,
  req: CreateTopicRequest
): Promise<CreateTopicResult> {
  const title = (req.title || "").trim() || "Untitled";
  const id = req.id ? req.id : slugify(title);

  if (!isValidTopicId(id)) {
    throw new Error(
      `Invalid topic id "${id}" — must match [a-z0-9][a-z0-9-]{0,63}`
    );
  }

  const registry = (await readRegistry(sessionRoot)) ??
    (await ensureRegistry(sessionRoot));

  if (registry.topics.some((t) => t.id === id)) {
    throw new Error(`Topic "${id}" already exists`);
  }

  const topic: Topic = {
    id,
    title,
    createdAt: Date.now(),
    ...(req.prompt ? { prompt: req.prompt } : {}),
  };
  registry.topics.push(topic);
  registry.activeId = id;

  const contentDir = topicContentDir(sessionRoot, id);
  await mkdir(contentDir, { recursive: true });
  await writeRegistry(sessionRoot, registry);

  return { topic, contentDir };
}

/**
 * Sets the active topic. Silently ignored if the id doesn't exist —
 * caller is expected to have validated.
 */
export async function setActiveTopic(
  sessionRoot: string,
  id: string
): Promise<TopicRegistry | null> {
  const registry = await readRegistry(sessionRoot);
  if (!registry) return null;
  if (!registry.topics.some((t) => t.id === id)) return null;
  registry.activeId = id;
  await writeRegistry(sessionRoot, registry);
  return registry;
}
