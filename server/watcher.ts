// server/watcher.ts
import { watch, type FSWatcher } from "fs";
import { basename } from "path";

export interface VariationChange {
  topicId: string;
  filename: string;
}

export type VariationChangeHandler = (changes: VariationChange[]) => void;

export interface ContentWatcher {
  start: () => void;
  stop: () => void;
}

/**
 * Watches the session's content directory (recursively) for new/changed
 * HTML files inside `content/<topicId>/round-N-*.html`. Callers receive
 * a list of {topicId, filename} tuples; they decide whether the change
 * is relevant to the client's currently active topic.
 *
 * Debounces rapid changes (300ms) so a batch of files written together
 * triggers one notification. Recursive watching is supported on macOS
 * and Windows; on Linux this falls back to non-recursive, which means
 * new topic directories won't be picked up until the server restarts —
 * acceptable since topics are created via HTTP, which is what drives
 * client refreshes anyway.
 */
export function createContentWatcher(
  contentRoot: string,
  onChange: VariationChangeHandler
): ContentWatcher {
  let fsWatcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<string, VariationChange>();

  function flush() {
    if (pending.size === 0) return;
    const changes = [...pending.values()].sort((a, b) => {
      if (a.topicId !== b.topicId) return a.topicId.localeCompare(b.topicId);
      return a.filename.localeCompare(b.filename);
    });
    pending.clear();
    onChange(changes);
  }

  function handle(rawPath: string) {
    // Recursive watch on macOS emits the relative path with forward
    // slashes. Non-recursive (Linux) emits just the filename. In the
    // non-recursive case we can't attribute to a topic, so we drop.
    if (!rawPath || !rawPath.endsWith(".html")) return;
    const parts = rawPath.split(/[/\\]/);
    if (parts.length < 2) return; // skip top-level files (shouldn't happen post-migration)
    const topicId = parts[0];
    const filename = basename(parts[parts.length - 1]);
    if (!/^round-\d+-[a-z]\.html$/.test(filename)) return;
    const key = topicId + "/" + filename;
    pending.set(key, { topicId, filename });
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, 300);
  }

  return {
    start() {
      try {
        fsWatcher = watch(contentRoot, { recursive: true }, (_evt, filename) => {
          if (typeof filename === "string") handle(filename);
        });
      } catch {
        // Recursive watch not supported — fall back to flat watch, which
        // only picks up changes in content/ itself (legacy layout).
        fsWatcher = watch(contentRoot, (_evt, filename) => {
          if (typeof filename === "string") handle(filename);
        });
      }
    },
    stop() {
      if (debounceTimer) clearTimeout(debounceTimer);
      fsWatcher?.close();
      fsWatcher = null;
    },
  };
}

/**
 * Parses a variation filename into round number and variation letter.
 * Expected format: round-{N}-{letter}.html
 * Returns null if the filename doesn't match.
 */
export function parseVariationFilename(
  filename: string
): { round: number; variation: string } | null {
  const match = basename(filename).match(/^round-(\d+)-([a-z])\.html$/);
  if (!match) return null;
  return { round: parseInt(match[1], 10), variation: match[2] };
}
