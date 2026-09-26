# harem

Eve is permanent. Every wife is an ephemeral subagent: spawn, work, argue, merge, despawn.

```
task -> planner (template or LLM) -> spawn 1-4 wives in parallel -> structured results
     -> conflicts (compare results, one quip per side, no bot-to-bot chat) -> Eve picks
     -> merge (distilled facts only) -> despawn -> action.request (asks, never does) -> task.done
```

| wife | role | tools |
|---|---|---|
| 🍜 Miso | food | WebSearch, WebFetch |
| 📅 Kari | calendar | none (schedule injected, read only) |
| 💸 Mina | budget | none (memories injected) |
| 🗺️ Yumi | logistics | WebSearch |
| 🔎 Rei | research | WebSearch, WebFetch |

Caps: `MAX_WIVES = 4`, depth 1. Wives have no spawn tool, so recursion can't happen.

## Use

```ts
import { executeWithHarem, ScriptedBrain, DEMO_SCRIPTS } from "@eigenwife/harem";
const out = await executeWithHarem({ taskId, goal, context }, { bus, world, brain?, mirror?, schedule? });
// out: { ok, summary, plan, agents, conflicts, choice?, action? }
```

- Emits `swarm.plan`, then `swarm.spawn`, `swarm.status`, `swarm.progress` and `swarm.done` per wife, then `swarm.conflict` / `swarm.resolve`, `swarm.merge`, `action.request`, and `task.done`.
- Side effects: emits `action.request` (`calendar.create`, EXTERNAL_SIDE_EFFECT) and waits for `action.approval`. Agency executes. Args are frozen: `{title, start, durationMin, location}`.
- `brain` defaults to `ClaudeCliBrain` (`claude -p --json-schema`, per-wife tool allowlist). `ScriptedBrain(DEMO_SCRIPTS)` is the deterministic stage path (~10s).

```bash
bun run packages/harem/src/cli.ts "figure out tonight"             # scripted, prints the beat
bun run packages/harem/src/cli.ts "figure out tonight" --live      # real claude wives (~1 min)
#   --bus      publish on the core hub so the shell sees it
#   --swarm    mirror wives into Open Swarm cards
#   --approve  auto-approve the calendar action
```

## Open Swarm (the harem room)

Open Swarm renders the cards. Harem does the work. Open Swarm's own agent loop needs an Anthropic key, so we launch idle sessions and puppet them:

```bash
git clone https://github.com/openswarm-ai/openswarm ~/dev/openswarm
packages/harem/openswarm/apply.sh                    # adds POST /api/agents/sessions/{id}/puppet
OSW_PREWARM_CLI=0 bash ~/dev/openswarm/backend/run.sh   # :8324
bash ~/dev/openswarm/frontend/run.sh                 # :3000, open the "Eve's Harem" dashboard
bun run packages/harem/src/cli.ts "figure out tonight" --swarm
```

The token is read from `~/dev/openswarm/backend/data/auth.token`. Override with `OPENSWARM_URL`, `OPENSWARM_TOKEN`, or `OPENSWARM_DIR`.
