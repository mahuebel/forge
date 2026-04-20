#!/usr/bin/env bun
// inject-forge-feedback.ts
//
// UserPromptSubmit hook for the forge plugin.
//
// On every user prompt, looks for active forge sessions in the current
// working directory (.forge/sessions/*). For each session with a live
// server and unprocessed events, formats those events and emits them as
// additionalContext — so Claude sees the developer's browser feedback
// on their next message.
//
// Cursor file: .forge/sessions/<id>/bridge/injected-cursor
//   — tracks last line number consumed by this hook, separate from the
//     bridge's own cursor (which tracks stdout logging).
//
// Output: prints a JSON object to stdout like:
//   {"hookSpecificOutput": {"additionalContext": "..."}}
// when there are events to inject. Silent (empty output) otherwise.

import { readFile, writeFile } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import { join } from "path";

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
}

async function main() {
  // Read hook input from stdin
  const input = await readStdin();
  let hookInput: HookInput = {};
  try {
    hookInput = JSON.parse(input);
  } catch {
    // If no stdin or malformed, use cwd
  }

  const cwd = hookInput.cwd || process.cwd();
  const sessionsDir = join(cwd, ".forge", "sessions");

  if (!existsSync(sessionsDir)) {
    return; // No forge sessions here — silent exit
  }

  const sessionIds = readdirSync(sessionsDir);
  const chunks: string[] = [];

  for (const sessionId of sessionIds) {
    const sessionChunk = await processSession(join(sessionsDir, sessionId));
    if (sessionChunk) chunks.push(sessionChunk);
  }

  if (chunks.length === 0) return; // No new events — silent

  const context = chunks.join("\n\n");
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: context,
      },
    })
  );
}

async function processSession(sessionDir: string): Promise<string | null> {
  const eventsFile = join(sessionDir, "state", "events.jsonl");
  const serverInfoFile = join(sessionDir, "state", "server-info.json");

  if (!existsSync(eventsFile)) return null;

  // Ownership check: only inject feedback from workspaces owned by THIS
  // Claude session. process.ppid here is the Claude Code PID, which matches
  // the claudePid recorded in server-info.json when the workspace was
  // launched via the skill. Skipping unowned workspaces prevents the hook
  // from stealing events that should go to another Claude session open in
  // the same project directory. Legacy workspaces (no claudePid) are
  // skipped — they must be restarted to participate in per-session routing.
  let serverInfo: { url?: string; claudePid?: number } = {};
  if (existsSync(serverInfoFile)) {
    try {
      serverInfo = JSON.parse(await readFile(serverInfoFile, "utf-8"));
    } catch {}
  }
  if (serverInfo.claudePid !== process.ppid) return null;

  // Cursor file is per-Claude-session (keyed by ppid) so two Claudes in the
  // same project can't race each other to advance a shared cursor.
  const cursorFile = join(sessionDir, "bridge", "injected-cursor-" + process.ppid);

  const cursor = existsSync(cursorFile)
    ? parseInt((await readFile(cursorFile, "utf-8")).trim(), 10) || 0
    : 0;

  const content = await readFile(eventsFile, "utf-8");
  if (!content.trim()) return null;

  const allLines = content.trim().split("\n").filter(Boolean);
  const unsent = allLines.slice(cursor);
  if (unsent.length === 0) return null;

  // Parse events and filter out heartbeats (noisy)
  const events = unsent
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((e) => e !== null && e.type !== "heartbeat");

  if (events.length === 0) {
    // Still advance cursor so we don't re-scan heartbeats
    await writeFile(cursorFile, String(allLines.length));
    return null;
  }

  // Advance cursor to end of file so we don't re-inject
  await writeFile(cursorFile, String(allLines.length));

  return formatEventsAsContext(events, serverInfo.url ?? "");
}

interface FormattableEvent {
  type: string;
  variation?: string;
  action?: string;
  label?: string;
  selector?: string;
  reason?: string;
  pin?: number;
  text?: string;
  round?: number;
  variations?: string[];
  prompt?: string;
  note?: string;
  shape?: string;
  topic_id?: string;
}

function formatEventsAsContext(events: FormattableEvent[], url: string): string {
  const lines: string[] = [];
  lines.push("## forge workspace feedback");
  if (url) lines.push(`Workspace: ${url}`);
  lines.push("");
  lines.push("The developer has provided the following feedback in the browser since your last message:");
  lines.push("");

  const wantsRefine = events.some((e) => e.type === "refine");
  const acceptedEvents = events.filter((e) => e.type === "accept");

  for (const e of events) {
    const topic = typeof e.topic_id === "string" ? `[${e.topic_id}] ` : "";
    switch (e.type) {
      case "verdict": {
        const v = (e.variation ?? "?").toUpperCase();
        const action = e.action === "like" ? "liked" : "rejected";
        const reason = e.reason ? ` — "${e.reason}"` : "";
        lines.push(`- ${topic}Variation ${v} ${action}${reason}`);
        break;
      }
      case "annotate": {
        if (e.shape === "general" || !e.variation) {
          lines.push(`- ${topic}General note (#${e.pin}): "${e.text}"`);
        } else {
          const v = (e.variation ?? "?").toUpperCase();
          lines.push(`- ${topic}Annotation on Variation ${v} (pin #${e.pin}, near \`${e.selector}\`): "${e.text}"`);
        }
        break;
      }
      case "select": {
        const v = (e.variation ?? "?").toUpperCase();
        const action = e.action === "like" ? "liked" : "rejected";
        lines.push(`- ${topic}Component on Variation ${v} ${action}: "${e.label}" (\`${e.selector}\`)`);
        break;
      }
      case "round": {
        lines.push(`- ${topic}Round ${e.round} generated: variations ${(e.variations ?? []).join(", ")} — prompt: "${e.prompt}"`);
        break;
      }
      case "refine": {
        lines.push(`- ${topic}Developer clicked **Refine** — they want a new round based on accumulated feedback.`);
        break;
      }
      case "accept": {
        const v = (e.variation ?? "?").toUpperCase();
        lines.push(`- ${topic}Developer **ACCEPTED** Variation ${v} — terminal pick for this topic/round.`);
        break;
      }
    }
  }

  lines.push("");
  if (acceptedEvents.length > 0) {
    lines.push(
      "**Action requested:** the developer has accepted a variation. Move to resolution — write the accepted variation into actual project files matching the stack's conventions. Do not regenerate unless explicitly asked."
    );
  } else if (wantsRefine) {
    lines.push(
      "**Action requested:** the developer wants you to generate the next round. Reference the accumulated feedback explicitly, then write new variation files (`round-N-*.html`) incorporating it."
    );
  } else {
    lines.push(
      "Acknowledge any verdicts or annotations briefly. Do not regenerate unless the developer explicitly asks."
    );
  }

  return lines.join("\n");
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    // If no stdin is piped (e.g. invoked directly), resolve quickly
    setTimeout(() => resolve(data), 50);
  });
}

main().catch((err) => {
  // Silent failure — never block the user's prompt
  process.stderr.write("[forge-hook] " + err.message + "\n");
});
