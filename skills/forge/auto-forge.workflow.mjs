// @ts-nocheck — Workflow script: runs in the Workflow sandbox where `agent`, `parallel`,
// `log`, `args` etc. are injected globals and top-level await/return are legal. It is NOT
// part of the TS build; the project type-checker can't model that context, so silence it.
//
// auto-forge: headless variation generation with a judge panel, no human in the loop.
//
// The interactive forge loop (server lifecycle, browser feedback, topic routing) stays in
// SKILL.md where it belongs. THIS script only owns the batch-shaped part a workflow is
// actually good at — fan out N variations, score them with a perspective-diverse judge
// panel, distill a critique, loop for the next round, return the trail.
//
// Boundary (deliberate):
//   - The workflow CANNOT touch the filesystem and CANNOT manage the server. So it does
//     NOT append round events to events.jsonl and does NOT write final project files.
//   - The calling skill passes in an absolute contentDir + topicId, invokes this via
//     Workflow({scriptPath}), then on return does the single-writer events.jsonl appends
//     (one per round) and the Phase-4 file write. That keeps the single-writer discipline
//     for events.jsonl in the parent, exactly as the interactive path does today.
//
// args shape (pass as a real JSON object, not a string):
//   {
//     contentDir: "/abs/.forge/sessions/<sid>/content/<topicId>",
//     brief:      "what every variation must satisfy",
//     slots:      [{ letter: "a", angle: "data-dense power-user" }, ...],
//     rounds:     2,        // how many generate→judge passes
//     lenses:     ["fitness-to-brief", "visual-hierarchy", "aesthetic-polish"]  // optional
//   }

export const meta = {
  name: 'auto-forge',
  description: 'Headless forge: generate variation rounds and pick a winner via judge panel — no human in the loop',
  whenToUse: 'When the developer wants forge to self-drive (generate, critique, refine, pick) instead of clicking in the browser. Invoked by /forge auto.',
  phases: [
    { title: 'Generate', detail: 'one forge-variation-worker per slot, in parallel' },
    { title: 'Judge', detail: 'perspective-diverse panel scores each variation' },
    { title: 'Critique', detail: 'distill what to keep/fix and seed the next round' },
  ],
}

// ---- schemas (forced structured output; agent() returns the validated object) ----

const VARIATION_RESULT = {
  type: 'object',
  required: ['letter', 'path', 'approach'],
  additionalProperties: false,
  properties: {
    letter: { type: 'string' },
    path: { type: 'string', description: 'absolute path actually written' },
    approach: { type: 'string', description: 'one sentence on the direction taken' },
  },
}

const VERDICT = {
  type: 'object',
  required: ['score', 'strengths', 'weaknesses', 'wouldShip'],
  additionalProperties: false,
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 100 },
    strengths: { type: 'array', items: { type: 'string' } },
    weaknesses: { type: 'array', items: { type: 'string' } },
    wouldShip: { type: 'boolean' },
  },
}

const CRITIQUE = {
  type: 'object',
  required: ['keep', 'fix', 'carryForward'],
  additionalProperties: false,
  properties: {
    keep: { type: 'array', items: { type: 'string' }, description: 'what the next round must preserve' },
    fix: { type: 'array', items: { type: 'string' }, description: 'concrete defects to address' },
    carryForward: { type: 'string', description: 'prose description of the winning design to seed the next round — replaces a file excerpt since workers cannot read files' },
  },
}

// ---- prompt builders ----

const otherSlots = (slots, me) =>
  slots.filter((s) => s.letter !== me.letter).map((s) => `- ${s.letter.toUpperCase()}: ${s.angle}`).join('\n')

function workerPrompt({ slot, round, contentDir, brief, slots, critique }) {
  const path = `${contentDir}/round-${round}-${slot.letter}.html`
  const feedback = critique
    ? `\n## Accumulated feedback from the prior round\nKeep:\n${critique.keep.map((k) => `- ${k}`).join('\n')}\nFix:\n${critique.fix.map((f) => `- ${f}`).join('\n')}\n\n## Winning design to evolve (carry forward, do not pixel-copy)\n${critique.carryForward}\n`
    : ''
  return `Variation ${slot.letter.toUpperCase()}, round ${round}.

Output path (absolute):
  ${path}

## Brief
${brief}

## Your angle
${slot.angle}

## Other variations in this round — do NOT duplicate their direction
${otherSlots(slots, slot)}
${feedback}`
}

function judgePrompt({ variation, lens, brief }) {
  return `You are judging one forge variation through a single lens: **${lens}**.

Read the HTML at this absolute path with the Read tool, then evaluate ONLY through the "${lens}" lens:
  ${variation.path}

## The brief every variation had to satisfy
${brief}

Score 0–100 for this lens alone. Be a harsh, specific critic — most first-pass UI is a 50–70. Reserve 85+ for genuinely shippable work on this dimension. List concrete strengths and weaknesses tied to what you actually saw in the markup. wouldShip = would you ship this as-is on this dimension.`
}

function critiquePrompt({ ranked, brief }) {
  const top = ranked.slice(0, 2)
  return `You are distilling a critique to seed the next round of forge variations. The winner so far:

${top.map((v) => `### Variation ${v.letter.toUpperCase()} (score ${v.score})\n  path: ${v.path}\n  strengths: ${v.strengths.join('; ')}\n  weaknesses: ${v.weaknesses.join('; ')}`).join('\n\n')}

## Original brief
${brief}

Read the top variation's HTML (Read tool, path above). Produce:
- keep: what the next round MUST preserve from the winner
- fix: the concrete defects the next round must resolve
- carryForward: a precise prose description of the winning design — layout, hierarchy, components, palette — detailed enough that a generator who CANNOT see the file can evolve it. This replaces a file excerpt.`
}

// ---- aggregation (plain code — no agent, no barrier needed) ----

function aggregate(variation, verdicts) {
  if (!verdicts.length) return null
  const score = Math.round(verdicts.reduce((s, v) => s + v.score, 0) / verdicts.length)
  return {
    letter: variation.letter,
    path: variation.path,
    approach: variation.approach,
    score,
    strengths: verdicts.flatMap((v) => v.strengths),
    weaknesses: verdicts.flatMap((v) => v.weaknesses),
    shipVotes: verdicts.filter((v) => v.wouldShip).length,
  }
}

// ---- orchestration ----

const cfg = args ?? {}
const brief = cfg.brief
const slots = cfg.slots ?? [
  { letter: 'a', angle: 'data-dense, power-user oriented' },
  { letter: 'b', angle: 'minimalist, single focal task' },
  { letter: 'c', angle: 'visual-first, chart-driven' },
]
const ROUNDS = cfg.rounds ?? 2
const LENSES = cfg.lenses ?? ['fitness-to-brief', 'visual-hierarchy', 'aesthetic-polish']
const contentDir = cfg.contentDir

if (!brief || !contentDir) throw new Error('auto-forge requires args.brief and args.contentDir')

const trail = []
let critique = null

for (let round = 1; round <= ROUNDS; round++) {
  log(`Round ${round}/${ROUNDS}: generating ${slots.length} variations`)

  // GENERATE — barrier is correct here: we judge the whole round together.
  const variations = (
    await parallel(
      slots.map((slot) => () =>
        agent(workerPrompt({ slot, round, contentDir, brief, slots, critique }), {
          agentType: 'forge-variation-worker',
          label: `gen:r${round}:${slot.letter}`,
          phase: 'Generate',
          schema: VARIATION_RESULT,
        }),
      ),
    )
  ).filter(Boolean)

  if (!variations.length) {
    log(`Round ${round}: no variations landed — stopping`)
    break
  }

  // JUDGE — every variation judged concurrently; each by a distinct-lens panel.
  const judged = (
    await parallel(
      variations.map((v) => () =>
        parallel(
          LENSES.map((lens) => () =>
            agent(judgePrompt({ variation: v, lens, brief }), {
              label: `judge:r${round}:${v.letter}:${lens}`,
              phase: 'Judge',
              schema: VERDICT,
            }),
          ),
        ).then((verdicts) => aggregate(v, verdicts.filter(Boolean))),
      ),
    )
  ).filter(Boolean)

  const ranked = judged.sort((a, b) => b.score - a.score)
  trail.push({ round, ranked })
  log(`Round ${round}: winner ${ranked[0].letter.toUpperCase()} (${ranked[0].score})`)

  // CRITIQUE — only if another round follows.
  if (round < ROUNDS) {
    critique = await agent(critiquePrompt({ ranked, brief }), {
      label: `critique:r${round}`,
      phase: 'Critique',
      schema: CRITIQUE,
    })
  }
}

const lastRound = trail[trail.length - 1]
const winner = lastRound?.ranked[0] ?? null

return {
  winner, // { letter, path, score, ... } — the skill writes this into project files
  trail, // [{ round, ranked: [...] }] — the skill appends one round event per entry
  rounds: trail.length,
}
