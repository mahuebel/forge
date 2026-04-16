---
description: Process accumulated forge workspace feedback and generate a new round of variations
---

The developer has invoked `/forge-refine` to explicitly request a new round of variations based on their browser feedback.

## Steps

1. **Find the active forge session** by looking for `.forge/sessions/*/state/server-info.json` in the current directory. Read the `sessionId`, `url`, and `eventsFile` from the first live one.

2. **Read the full event stream** from `eventsFile` (the JSONL file). Parse each line. Ignore `heartbeat` events.

3. **Advance the injected-cursor** — write the total line count to `.forge/sessions/<sessionId>/bridge/injected-cursor` so the `UserPromptSubmit` hook doesn't re-inject the same events on the next prompt.

4. **Summarize the feedback** for the developer:
   - List each variation's verdict (liked/rejected + any reason)
   - List each annotation (variation, pin number, selector, text)
   - List any component selections

5. **Generate the next round:**
   - Determine the next round number from the highest existing `round-N-*.html` in the content directory
   - Write new variation files (`round-{N+1}-a.html`, `round-{N+1}-b.html`, etc.) that address the feedback:
     - Keep what was liked
     - Address annotation notes
     - Discard or evolve from what was rejected
   - Append a `round` event to `events.jsonl` bookmarking the new generation

6. **Tell the developer** variations are ready at the workspace URL.

## Key points

- Reference specific feedback when describing the new round ("You liked A's sidebar and noted B's toggle spacing, so Round 2 combines…")
- Each new variation must be a complete self-contained HTML document
- Match the visual polish and distinctness rules from the SKILL.md for forge

If no forge session is running, tell the developer to launch the workspace first by invoking `/forge <prompt>`.
