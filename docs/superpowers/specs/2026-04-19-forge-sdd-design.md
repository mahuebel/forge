# forge-sdd — Spec-Driven Design System

**Status:** Draft
**Date:** 2026-04-19
**Author:** Mark Huebel (with Claude)

## Problem

Superpowers provides a rigorous spec → plan → execute pipeline, but every stage is prose-only. For UI and architecture decisions, prose is a lossy translation layer — users describe visual intent in words, the model interprets, rounds of drift follow.

Forge solves the last mile for UI iteration (visual variations + structured browser feedback), but stops at polish. There is no authoring layer above it (what are we designing and why?) and no execution layer below it (how do we build what we picked?).

`forge-sdd` is the connecting tissue: a spec-driven design system where the brainstorming stage drives forge for decision-making across UI *and* architecture, produces a persisted spec + decision log, flows into a plan document, and executes via subagent teams and Claude Code's agent-teams feature with superpowers' TDD / worktree / verification practices baked in.

## Goals

- Every non-trivial design decision expressed as visual variations in forge before commitment, regardless of whether the decision is UI, topology, or library choice.
- Every accepted variation produces a durable structured decision record with rationale, surviving context compaction and available as an audit trail.
- Plan authoring is a fork of `superpowers:writing-plans` with a small, auditable diff: UI workstreams default to `frontend-design` + `ui-ux-pro-max` skills; every phase declares workstreams for parallel execution; high-stakes tasks auto-trigger per-task plan approval.
- Execution defaults to subagent-driven dispatch (matching superpowers practice) and escalates to Claude Code's agent-teams feature for phases tagged as research-heavy, cross-layer, or competing-hypothesis work.
- Git hygiene is non-negotiable: plan worktree, workstream worktrees inside team phases, granular commits within worktree, squash-on-merge.
- Recovery from mid-stage session loss is a first-class flow, not an afterthought.

## Non-goals

- Replacing superpowers' TDD, worktree, verification, receiving-code-review, or finishing-a-development-branch skills. `forge-sdd` invokes them.
- Changing forge's own semantics. `forge-sdd` uses forge as-is via its existing HTTP API and event stream.
- Multi-user or remote collaboration. Single-developer local flow only.
- Covering projects that fit on one screen and one commit. Those don't need SDD; SDD is for work that justifies a design stage.

## Decisions reference (carried forward from brainstorming)

| ID | Decision | Chosen |
|---|---|---|
| d-01 | Plugin packaging | C3 — fork a minimal set of superpowers skills (brainstorm / write-plan / execute); soft-dep on superpowers for everything else |
| d-02 | Visual rendering per question | C — classify decision type and pick rendering (topology → diagram, library/pattern → card, UI → mockup, cross-cutting → multi-panel) |
| d-03 | Forge topic granularity | C+C3 — cluster topics per subsystem, drill-down sub-topics for flagged details |
| d-04 | Decision records | D — persist to `decisions.json`, stakes 1–3, editable readout for stakes-3, silent persist otherwise |
| d-05 | Execution model | D — subagent dispatch default, agent-teams for phases tagged `execution: team` |
| d-06 | Invocation shape | A3 + H3 — skill-based description triggers with thin slash-command shortcuts; auto brainstorm→plan handoff, hard user checkpoint at plan→execute |
| d-07 | Native plan mode integration | Used at (a) execute approval gate and (b) per-task approval for stakes-3 tasks via agent-teams `require_plan_approval` |
| d-08 | Worktree policy | W2 default (plan worktree), W3 auto inside team phases, `--no-worktree` flag to force W1 |
| d-09 | TDD policy | T2 — default on, tag `tdd: skip` per task with rationale |
| d-10 | Commit policy | G3 — granular commits within worktree, squash on merge to plan branch |

## Architecture

Three stages, one state spine, two-way handoffs via persisted artifacts.

```
┌──────────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
│ Stage 1: Brainstorm  │   │ Stage 2: Plan        │   │ Stage 3: Execute     │
│ forge-sdd:brainstorm │──▶│ forge-sdd:write-plan │──▶│ forge-sdd:execute    │
│ + forge workspace    │   │ (fork of SP's        │   │ + native plan mode   │
│                      │   │  writing-plans)      │   │ + agent teams        │
└──────────┬───────────┘   └──────────┬───────────┘   └──────────┬───────────┘
           │                          │                          │
           ▼                          ▼                          ▼
    spec.md                     plan.md                  worktree + commits
    decisions.json              (status updated          + merges to base
                                 in-place during exec)
              (all rooted at .forge-sdd/sessions/<session-id>/)
```

State file (`state.json`) tracks current stage, artifact paths, and session metadata. Every command resolves context from it; `--resume <session-id>` flag re-enters at the last known stage.

### Component inventory (shipped by this plugin)

| Component | Kind | Role |
|---|---|---|
| `forge-sdd:brainstorm` | skill (forked from `superpowers:brainstorming`) | Visual-driven brainstorming, emits spec + decisions.json |
| `forge-sdd:write-plan` | skill (forked from `superpowers:writing-plans`) | Authors plan.md with SDD-specific defaults |
| `forge-sdd:execute` | skill (forked from `superpowers:executing-plans`) | Drives subagent/team dispatch, worktrees, TDD, verification |
| `forge-sdd:decision-classifier` | skill (new) | Small skill: given a question, classifies decision_type and picks rendering |
| `/sdd-brainstorm` `/sdd-plan` `/sdd-execute` | commands | Thin slash-command shortcuts invoking the skills directly |
| Hook scripts | hooks | `TaskCreated`, `TaskCompleted`, `TeammateIdle`, `Stop` — registered in `plugin.json` |

### Components invoked (soft dependencies)

- **Superpowers:** `test-driven-development`, `using-git-worktrees`, `verification-before-completion`, `finishing-a-development-branch`, `subagent-driven-development`, `receiving-code-review`.
- **Forge:** existing `forge:forge` skill for workspace launch, topic creation via `POST /api/topics`, event streaming via channel or hook fallback.
- **UI skill defaults:** `frontend-design`, `ui-ux-pro-max` — baked into UI workstream templates.
- **Agent teams:** requires Claude Code ≥ 2.1.32 and `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Only activated inside phases tagged `execution: team`.

## Stage 1 — Brainstorm

### Entry

Description-match on the brainstorm skill (primary), or explicit `/sdd-brainstorm <topic>`.

### Session bootstrap

1. Create `.forge-sdd/sessions/<timestamp-slug>/` with `state.json` seeded (`stage: brainstorm`, timestamps).
2. Standard context exploration (files, docs, recent commits), same as upstream superpowers brainstorming.
3. Scope check. If the request spans independent subsystems, decompose into sub-projects and brainstorm the first. Each sub-project gets its own SDD session.
4. Launch or reuse forge workspace using the existing `forge:forge` skill mechanics (PID ownership, version match, port selection).
5. Visual companion offer is implicit — forge *is* the visual companion. Skip the upstream superpowers offer message.

### Question loop

For each question during brainstorming:

1. Claude authors the question + 3 candidate answers and tags the question:
   - `decision_type`: `topology` | `library-or-pattern` | `ui` | `cross-cutting`
   - `stakes`: `1` | `2` | `3`
   - `cluster_id`: subsystem grouping (e.g., `auth`, `data-model`, `deploy`)
2. `decision-classifier` skill picks rendering from `decision_type`:
   - `topology` → Mermaid or D2 diagram + rationale panel
   - `library-or-pattern` → decision card (pros / cons / risks / snippet preview)
   - `ui` → mockup (existing forge UI pattern)
   - `cross-cutting` → multi-panel (diagram + card + code sketch + blast-radius note)
3. Claude creates a forge topic per question (`POST /api/topics` with title derived from question).
4. Claude writes 3 HTML variation files to the topic's `contentDir` using chosen rendering, appends a `round` event to `events.jsonl`.
5. Claude tells user: "Topic ready — tab `<question>` at `<workspace_url>`."
6. User interacts in browser. Events stream to Claude via channel (or hook fallback):
   - `verdict` — accept/reject whole variation
   - `annotate` — pin with note
   - `select` — component click
7. When user signals acceptance for the topic ("go with A", "accept B", "finalize"):
   - Read all events for this `topic_id`.
   - If any annotations flagged for drill-down, spawn sub-topic(s) per flagged detail (e.g., "token rotation details") and loop the question loop at the sub-topic level. Cluster topic's decision record waits on sub-topics.
   - Build decision record (schema below).
   - If `stakes: 3`, present draft record to user for approval or edit before locking.
   - If `stakes: 1` or `2`, commit record silently; print one-line readout.
   - Append record to `decisions.json`.

#### Decision record schema

```json
{
  "id": "d-003",
  "cluster_id": "auth",
  "question": "Session storage strategy",
  "decision_type": "library-or-pattern",
  "stakes": 3,
  "forge_topic_id": "auth-session-storage",
  "options_considered": ["jwt-cookies", "server-sessions", "event-sourced"],
  "chosen": "event-sourced",
  "variation_accepted": "round-2-a",
  "rationale": "Auditability requirement from compliance; team has Kafka ops experience",
  "annotations_addressed": [
    {"pin_id": "p-7", "note": "use refresh tokens not rolling", "resolution": "refresh"}
  ],
  "open_followups": [],
  "decided_at": "2026-04-19T20:15:00Z"
}
```

#### Readout format (Claude session)

```
✓ Decision recorded: d-003 — Session storage: event-sourced
  Rationale: auditability requirement; team has Kafka experience
  Addressed: pin-7 (refresh tokens over rolling)
  → Next: Auth — MFA approach
```

### Spec emission

When the user signals brainstorm is done:

1. Read full `decisions.json`.
2. Synthesize `spec.md` at `docs/sdd/specs/YYYY-MM-DD-<topic>-design.md`. Sections: Problem, Goals, Non-goals, Architecture, Component Breakdown, Data Flow, Error Handling, Testing. Each load-bearing claim cross-references a decision ID.
3. Run the superpowers spec self-review loop: placeholders, contradictions, scope, ambiguity. Fix inline.
4. Commit `spec.md` and `decisions.json` in one commit.
5. Present to user: "Spec at `<path>`. Review and tell me to proceed — I'll advance into plan-writing."
6. On user acknowledgement, update `state.json` (`stage: plan`, `spec_path`, `decisions_path`) and advance to Stage 2 in the same session.

## Stage 2 — Plan

### Entry

Auto-advance from brainstorm after user reviews spec (same session), or `/sdd-plan <spec-path>` for standalone / resume.

### Input

- `spec.md` + `decisions.json` from Stage 1 (primary path).
- Standalone path: user-provided spec, empty or absent `decisions.json`. In this mode, plan tasks cannot cross-reference decision IDs but everything else works.

### Fork discipline

`forge-sdd:write-plan` starts as a verbatim copy of `superpowers:writing-plans` and applies this additive diff:

1. Plan schema extended with per-task tags (see below).
2. UI workstream template: any workstream whose tasks touch `*.tsx`, `*.jsx`, `*.vue`, or declared component directories gets `default_skills: [frontend-design, ui-ux-pro-max]` prepended to its task instructions.
3. Workstream-first phases: every phase emits a `workstreams:` section (≥1). Sequential work is a single workstream with task dependencies; parallel work is multiple workstreams.
4. Decision cross-references: each plan task can declare `implements: [d-003, d-007]`. Plan header reports coverage (decisions referenced / total).
5. Drop upstream writing-plans text about "ask one question at a time" — the plan stage synthesizes, not asks.

Upstream diff is kept small so improvements can be ported.

### Plan doc structure (`docs/sdd/plans/YYYY-MM-DD-<topic>-plan.md`)

```markdown
# Plan: <topic>
Spec: <path>  |  Decisions: <path>  |  Coverage: 17/18

## Phase 1 — <name>
execution: subagent

### Workstream: schema
worktree: default
tasks:
  - id: t-001
    title: Add users table migration
    implements: [d-004]
    stakes: 2
    tdd: auto
    files: [migrations/, db/schema.ts]

### Workstream: auth-service
worktree: default
tasks:
  - id: t-002
    title: Event-sourced session store
    implements: [d-003]
    stakes: 3
    tdd: auto
    require_plan_approval: true
    files: [services/auth/session.ts, tests/auth/session.test.ts]
    depends_on: [t-001]

## Phase 2 — UI
execution: team
team_size: 3

### Workstream: login-flow
worktree: required
default_skills: [frontend-design, ui-ux-pro-max]
tasks:
  - id: t-010
    ...
```

### Task tags and defaults

| Tag | Default | Notes |
|---|---|---|
| `stakes` | inherited from implementing decision, else `1` | Brainstorm stakes carry forward via `implements` |
| `tdd` | `auto` | T2 — `skip` allowed per task with rationale in the task body |
| `execution` | inherits phase level | Rare to override |
| `require_plan_approval` | `true` if `stakes: 3`, else `false` | Maps to agent-teams feature |
| `default_skills` | `[frontend-design, ui-ux-pro-max]` for UI workstreams | Automatic from file-pattern detection |
| `worktree` | `default` (plan worktree); `required` in team phases | Forced `required` inside team phases |

### Authoring loop

1. Read spec + decisions.json.
2. Draft phase breakdown. Heuristic for `execution: team`: (a) cross-layer coordination, (b) competing-hypothesis debugging, or (c) research/review across independent dimensions. Implementation phases with clear boundaries default to `subagent`.
3. Decompose phases into workstreams — maximize parallelism where file ownership allows.
4. For each task: choose skill defaults, carry stakes from decisions, set TDD and approval tags.
5. Emit `plan.md`.
6. Spec self-review adapted for plans: placeholders, contradictions, scope, ambiguity, **coverage check** (every stakes-3 decision implemented by ≥1 task — advisory, don't block on gaps but surface them).
7. Present plan to user for review. **Hard checkpoint** — no auto-advance to execute.
8. Commit `plan.md`.

### State transition

`state.json` gets `stage: execute_pending`, `plan_path` set. Awaits explicit user signal to proceed.

## Stage 3 — Execute

### Entry

User says "execute" (or equivalent) after plan review, or `/sdd-execute <plan-path>` for standalone / resume.

### Preflight

1. Load `plan.md`, `spec.md`, `decisions.json` from `state.json`.
2. Git state check — clean tree or user-confirmed stash; fail fast otherwise.
3. **Native plan mode gate.** Call `EnterPlanMode`; load a summarized plan as the proposal:
   - Phase count, workstream count, task count
   - Stakes-3 task list
   - Team phases and team size
   - Estimated commit count
   User approves natively → that is the go signal. Rejection returns to plan-review checkpoint.
4. `--no-worktree` flag skips plan worktree but not team-phase isolation (which is load-bearing for correctness).
5. Open plan worktree via `superpowers:using-git-worktrees`. Branch: `sdd/<plan-slug>`.
6. `state.json`: `stage: executing`, `worktree_path`, `started_at`.

### Phase dispatch

Phases run sequentially. Within each phase, branch on `execution:` tag.

#### Subagent phase

1. Topological sort of tasks across the phase's workstreams by `depends_on`.
2. Dispatch tasks independent of each other **in parallel within one Claude turn** (multiple Agent tool calls in a single message). Batch N+1 waits for batch N.
3. Subagent prompt content:
   - Task metadata (id, title, files)
   - `implements: [d-XXX]` with rationale excerpted from `decisions.json`
   - Skill defaults (UI workstreams include `frontend-design` + `ui-ux-pro-max` skill invocations in the prompt)
   - TDD directive unless `tdd: skip`
   - Commit directive (G1 — one commit per task)
4. Subagent returns diff summary + test results + commit SHA.
5. Main session verifies via `superpowers:verification-before-completion` at phase boundary (not per-task): build, typecheck, lint, tests.
6. Update `plan.md` in-place with task status, commit SHA, runtime.

#### Team phase

1. Verify `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and Claude Code ≥ 2.1.32. Fail with actionable message if not.
2. For each workstream: `git worktree add` a branch off the plan worktree (W3). Branch: `sdd/<plan-slug>/<workstream-id>`.
3. Ask team lead (main session) to create an agent team, `team_size` teammates from plan, typed via existing subagent definitions (prefer user-scope specialists like `frontend-designer` / `backend-dev`; fall back to generic).
4. Each teammate spawned with:
   - `cwd` = its workstream worktree path
   - Spawn prompt: workstream tasks, decisions refs, skill defaults, TDD mandate
   - `require_plan_approval: true` if the workstream owns any stakes-3 task
5. Seed the shared task list from the plan's workstream tasks, preserving `depends_on`.
6. Main session monitors via plugin-registered hooks:
   - `TeammateIdle` — nudge (exit 2) if plan tasks remain for that teammate
   - `TaskCreated` — block teammate-added tasks not in the plan; configurable off
   - `TaskCompleted` — run workstream-scoped verification
7. Stakes-3 tasks: teammate plans in read-only mode, lead approves/rejects with reference to decisions.json rationale.
8. Phase end: each workstream squash-merges to plan worktree (G3). Clean up workstream worktrees. Lead cleans up the team.
9. Main session runs phase-level verification on the plan worktree.

### Between phases

- Commit `plan.md` status updates.
- If phase output contradicts spec (surfaced by verification), present user options: "amend spec + replan downstream phases" or "fix forward."
- No auto-advance when a phase has non-clean exit.

### Plan completion

1. All phases green → invoke `superpowers:finishing-a-development-branch`. User picks merge / PR / keep-branch.
2. `state.json`: `stage: done`, `completed_at`, final commit SHA.

### Failure & recovery

- **Subagent phase failure:** re-dispatch failed tasks with accumulated context (error output, previous diff). Max 2 retries per task before stopping phase and handing to user.
- **Team phase failure:** lead messages the failing teammate directly or spawns a replacement (docs-recommended pattern). If teammate loop fails, tear down team, checkpoint in `plan.md`, return to main session.
- **Mid-execute session crash:** `/sdd-execute --resume <session-id>` re-reads state + plan status, re-enters worktree, rebuilds dependency graph from incomplete tasks. Team phases that were mid-flight: respawn team (teams don't survive `/resume` per docs); already-completed tasks pre-marked done.
- **`Stop` hook on main session during executing stage:** writes current `state.json` snapshot so `--resume` is always current.

## Data artifacts

All paths rooted at `.forge-sdd/sessions/<session-id>/` unless noted.

| Artifact | Path | Written by | Schema |
|---|---|---|---|
| `state.json` | session root | all stages | `{stage, session_id, spec_path, plan_path, decisions_path, worktree_path, started_at, stage_history[]}` |
| `decisions.json` | session root | brainstorm | `{decisions: [<record>]}` (record schema in Stage 1) |
| `spec.md` | `docs/sdd/specs/YYYY-MM-DD-<topic>-design.md` (committed) | brainstorm | Markdown, sections defined above |
| `plan.md` | `docs/sdd/plans/YYYY-MM-DD-<topic>-plan.md` (committed) | write-plan, updated by execute | Markdown + YAML-style task blocks |
| Forge events | `.forge/sessions/<id>/state/events.jsonl` | forge + brainstorm | Existing forge schema; SDD reads only |

## Testing strategy

- **Unit / integration per-skill:** each forked skill has a fixture-driven test that runs it against a canned spec/decisions/plan and asserts artifact shapes. Lives alongside the plugin.
- **End-to-end smoke:** a scripted walkthrough — minimal brainstorm session, synthetic forge events injected, plan generation, execute with two mock subagent phases (no real team phase — tokens prohibitive for CI). Verifies the state spine and handoffs.
- **Manual gates:** team-phase execution and native plan mode integration are manually verified against real Claude Code sessions; they cannot be unit-tested inside the plugin.

## Prerequisites

- Claude Code ≥ 2.1.32
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` set in environment or settings.json (only required if team phases are used)
- `forge` plugin installed and working (Bun ≥ 1.0)
- `superpowers` plugin installed
- User-scope subagent definitions for at least generic `frontend-designer` and `backend-dev` (optional; plugin falls back to generic dispatch)

## Open items / deferred decisions

- Exact topology-diagram DSL (Mermaid vs D2 vs excalidraw). Decide during implementation; tunable inside the brainstorm skill without architectural impact.
- Whether forge tab bar should visually nest sub-topics under cluster topics. Forge-side UX concern, not SDD's. If desired, it's a forge change.
- Subagent dispatch prompt templates — implementation detail, not spec.
- Hook script internals — implementation detail.

## Risks

- **Agent teams is experimental.** Known limitations: no session resumption with in-process teammates, task status lag, slow shutdown. Team-phase execution is the highest-risk surface in this design. Mitigation: subagent-driven default keeps the common path out of this risk.
- **Plan drift from spec during execute.** `implements:` cross-references rot if execution diverges. Mitigation: treat as advisory, surface drift via coverage checks, don't block on it.
- **Token cost.** Multi-topic brainstorm + decisions.json + forge variation HTML + plan + team-phase execution is materially more expensive than a single superpowers flow. Mitigation: stakes-based gating — only high-stakes decisions trigger the editable-readout flow; subagent default avoids team-phase cost on most work.
