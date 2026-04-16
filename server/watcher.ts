// server/watcher.ts
import { watch, type FSWatcher } from "fs";
import { basename } from "path";

export type VariationChangeHandler = (files: string[]) => void;

export interface ContentWatcher {
  start: () => void;
  stop: () => void;
}

/**
 * Watches a content directory for new/changed HTML files.
 * Calls onChange with a sorted list of filenames when changes are detected.
 * Debounces rapid changes (300ms) so a batch of files written together
 * triggers one notification.
 */
export function createContentWatcher(
  contentDir: string,
  onChange: VariationChangeHandler
): ContentWatcher {
  let fsWatcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingFiles = new Set<string>();

  function flush() {
    if (pendingFiles.size === 0) return;
    const files = [...pendingFiles].sort();
    pendingFiles.clear();
    onChange(files);
  }

  return {
    start() {
      fsWatcher = watch(contentDir, (_eventType, filename) => {
        if (!filename || !filename.endsWith(".html")) return;
        pendingFiles.add(filename);
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(flush, 300);
      });
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
