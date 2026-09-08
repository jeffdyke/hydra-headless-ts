---
name: session-debrief
description: End-of-session retrospective that promotes durable learnings into the repo's docs. Use when wrapping up a task, before committing, or whenever the human asks "is there anything we learned that should be saved."
---

# Session Debrief

Most non-trivial sessions on this repo surface something that would help the next person: a Hydra/Salt/Compose footgun, a non-obvious script or helper, a doc that's wrong or missing a case, a clarification the user made about how staging/prod actually behaves. If that knowledge dies with the session, the next person — often the same user, months later — re-discovers it the hard way (this has already happened once: the `env_file` restart-vs-recreate gotcha was documented in `STAGING_TROUBLESHOOTING.md` and still cost a long debugging detour in prod before it was found again).

This skill is a forcing function: pause before declaring a session done and ask, "what did we learn that belongs in the repo?"

## When to invoke

- The human explicitly asks (any phrasing like "is there anything we should save," "what should we capture," "anything for memory or skills").
- You're at the natural wrap-up of a task, before committing or closing out an incident.
- The session involved a production incident, a multi-step diagnosis, or non-trivial user corrections.

Do **not** invoke for tiny one-shot tasks (typo fixes, single-line changes).

## During the session

Don't wait for the debrief to notice. While working, watch for:

- **A user correction that reveals a missing rule** — you did something the reasonable way and were told the repo's/deploy's actual way instead.
- **A workflow performed more than once, or that required multiple round-trips of asking the user to run a command** — a diagnostic sequence, a Compose/Hydra/Salt recipe worth writing down so the next session doesn't have to ask one command at a time.
- **A doc that already covered the issue but wasn't found in time.** This is the highest-value signal this repo produces: `STAGING_TROUBLESHOOTING.md` is a symptom-first catalogue precisely because these mistakes repeat. If a debugging detour ends with "oh, that's already bullet 2 under Docker Compose," the fix isn't a new bullet — it's making that bullet impossible to miss (broader title/scope, a cross-link from wherever the symptom actually shows up first).
- **A non-obvious tooling footgun** — a command that succeeded while doing nothing (`docker compose restart` not re-reading `env_file`), a config edit that doesn't propagate until a specific extra step (Salt pillar needing `blgit pull` + `state.sls` on the target env's salt master; a container needing `up -d`, not `restart`, to pick up new env), a bare `docker compose` resolving to the wrong project/files on a deployed host.
- **Application-level gotchas discovered by reading source**, not just ops mistakes — e.g. `ensureClient()` minting a throwaway Hydra client before failing, which turns a stale-config problem into a crash-loop that pollutes `hydra list clients`.

Log each one briefly in conversation the moment you notice it, and revisit the list at debrief time.

## What to look for

Scan the session for any of these signals. They are the items most likely to repay codification:

| Signal | Example from this repo |
|---|---|
| User correction that revealed a convention | "the deployed host runs project `hydra-mcp` via two `-f` files, not project `hydra` from `docker-compose.yml`'s own `name:`" |
| Non-obvious build/tooling step | "recreate with `up -d`, don't `restart` — `env_file` is only read at container creation" |
| Config propagation has more layers than it looks | Salt pillar → rendered `hydra.env` → running container are three separate "did it actually take effect?" checkpoints, each with its own failure mode |
| New shared script or helper | `scripts/compose-env.sh` (auto-detects deployed vs. local compose project so new scripts don't have to re-derive it) |
| Application-code gotcha found by reading source, not docs | `ensureClient()` creates a new client before exiting 1 on failure — this is why a crash loop mints orphans instead of just failing cleanly |
| Repeated mistake pattern / doc that existed but wasn't found | Same `env_file`-not-reloading class of mistake hit again despite being documented |
| Skill/doc gap | A topic that took multiple back-and-forths (or several rounds of "can you run X") because nothing covered it |

## Where each finding belongs

This repo has no `CLAUDE.md` — its durable knowledge lives in topic docs at the repo root. Route decisions, in order of preference:

1. **An existing topic doc** — this repo's primary home for durable facts:
   - `STAGING_TROUBLESHOOTING.md` — symptom-first catalogue of ops/deploy mistakes (Compose, Hydra/Google OAuth client config, nginx/HAProxy, mariadb-mcp instances). Despite the name, its content applies to prod too; most incident-debrief findings land here.
   - `LOCAL_TESTING.md` — the local dev stack, drift between dev and Salt-rendered staging/prod.
   - `AUTH_FLOW.md` / `OAUTH2_ARCHITECTURE.md` — how the OAuth/Hydra flow and client model are *designed*; put a finding here if it's about the app's behavior/architecture rather than an ops mistake (e.g. `ensureClient`'s fallback-creation behavior).
   - `DEVELOPMENT.md` — workflow, testing, linting, build.
   Always check whether an existing bullet already half-covers the finding before adding a new one — prefer sharpening/broadening an existing bullet over duplicating it.
2. **Existing skill** under `.claude/skills/<name>/SKILL.md` — check first; there may be more here by the time you read this.
3. **New skill** under `.claude/skills/<new-name>/SKILL.md` — only when the learning is a repeatable *procedure* (an ordered diagnostic runbook, a recovery recipe) rather than a fact, and doesn't fit any existing doc's scope. A symptom-and-fix fact belongs in a topic doc above, not a new skill.
4. **Personal memory** at `/Users/<user>/.claude/projects/<project>/memory/` — only for things specific to the individual: their role, account-level blockers, preferences about how Claude should interact with them. **Never put codebase or infra facts here** — they don't reach teammates, and this repo's whole point is that ops knowledge is shared via committed docs.

## Workflow

1. **List candidates.** Without yet writing anything, enumerate the learnings from this session in one short list. Be specific (cite the moment in the conversation when each came up).
2. **Classify each.** For each candidate, name the target location (specific doc + section, a skill file, or "skip — not worth capturing"). If unsure between two docs, pick the one most users would search first.
3. **Surface to the human.** Present the list with proposed targets. Ask which to apply. Don't write to docs or skills without confirmation — these are shared files, and some (like `STAGING_TROUBLESHOOTING.md`) are read under time pressure during a live incident, so bad edits are costly.
4. **Apply.** For each approved item, edit the target file with a concise rule and the constraint/evidence it protects. Match the surrounding style (`STAGING_TROUBLESHOOTING.md`'s bullets: bold one-line symptom, then the explanation and fix). Keep a dated incident reference only when it *is* the evidence; drop the rest of the narrative.
5. **Cross-link if useful.** If a new skill is created, mention it from `README.md` or the closest topic doc so it's discoverable outside of `.claude/skills`.

## Anti-patterns

- **Hoarding to personal memory.** Codebase/infra learnings belong in the repo's docs. Personal memory is single-user and invisible to teammates debugging the same prod host at 2am.
- **New skill for a one-off fact.** Add a bullet to `STAGING_TROUBLESHOOTING.md` or the relevant doc instead. A skill is for a repeatable procedure, not a catalogue entry.
- **Vague entries.** "Be careful with env files" is useless. Quote the exact failure ("`docker compose restart` reuses the existing container's already-baked environment; it does not re-read `env_file:`. Use `up -d` instead.").
- **Skipping the surface step.** Writing to shared docs without human confirmation is a hidden commit. Always show the proposed change first.
- **Writing the incident narrative instead of the rule.** Capture the durable constraint and its fix, not the story of how the session found it — that belongs in `build/`-style scratch notes or the PR description, not the doc.
