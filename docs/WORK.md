# Work

Eve as a coworker. She knows which repo you're in, finds and reads your files, ships code in an isolated branch with Claude Code, hands email / classes / reminders to jabby, and runs a shell command when you read it back and say yes. Every one of those goes through the agency gate (`docs/AGENCY.md`): permission class, deny list, budget, spoken approval, trace.

Jabby is the brain and already has the hands. Eve doesn't reimplement gmail, syla or discord: she relays to the live jabby daemon (`POST :4632/api/chat`) with an explicit "how much you may do" header, and speaks the answer.

```
 "ship dark mode in eigenwife"
   reflex: work ask -> ESCALATE -> "on it."
   work.handle
     resolve repo (utterance > work context > claude session cwd > ask "which repo?")
     task.start {brain:"claude-code"}
     code.task   EXTERNAL_SIDE_EFFECT  "have claude code ship dark mode in eigenwife on its own branch, yeah?"  "yeah"
       git worktree add -b eve/dark-mode-xxxxx ~/.eve/work/worktrees/eigenwife/...
       claude -p ... --permission-mode dontAsk --allowedTools Read,Edit,Write,...,Bash(bun test:*)
         stream-json -> swarm.progress (one CODER worker in the swarm view) + work.task chip
       diff stat, detected test command (in the worktree)
     she says: "<claude's 2 sentences>. 3 files, tests pass."
     code.merge  SENSITIVE_ACTION      "merge it and push to main?"
       yes: one commit (no attribution), rebase onto origin/main, git push origin HEAD:main (never forced), remove worktree
       no:  code.keep commits on the branch locally, removes the worktree dir, "it's on branch eve/dark-mode-xxxxx"
     task.done -> she reports the result line
```

## What she can do

| Ask | Action | Class | Notes |
|---|---|---|---|
| "find my resume", "where's that pdf from last week" | `files.search` | READ | Spotlight (`mdfind`) under `~`, name matches first then content, newest first, noise (Library, node_modules, .git, dotdirs) and denied paths dropped |
| "what's in package.json", "summarize my notes.md" | `files.read` | READ | text, PDF (PDFKit via JXA, path as argv), docx/rtf/html (`textutil`); 40MB cap, first 400KB read, secrets redacted, 1-3 sentence summary |
| "open my resume", "open figma" | `files.open` | SAFE_ACTION | `open` a file / url / app; executables (`.command`, `.sh`, `.app` paths, `.pkg`...) refused, deny-listed apps refused |
| "ship X", "fix X in <repo>", "implement / refactor / add a <code thing>" | `code.task` | EXTERNAL_SIDE_EFFECT | isolated worktree + headless Claude Code, progress in the swarm view |
| (after code.task) "merge it and push?" | `code.merge` | SENSITIVE_ACTION | commit + rebase + push, only on a spoken yes |
| (after a no) | `code.keep` | SAFE_ACTION | local commit on the `eve/*` branch, worktree removed, branch kept |
| "run the tests", "git status", "are the tests passing" | `code.status` | READ | git facts + the repo's test command in your checkout (read-only for git) |
| "what am i working on" | (context) | none | "you're in eigenwife (main, 3 dirty files) in Cursor." |
| "what's due this week", "check my email", "any internships", "ask jabby ..." | `jabby.ask` | READ | jabby is told READ ONLY: look, never send / reply / archive / schedule |
| "remind me to ...", "set a reminder" | `jabby.act` | EXTERNAL_SIDE_EFFECT | asked first; jabby may act but never message anyone but matt |
| "email leo saying ...", "dm X that ..." | `jabby.draft` then `jabby.send` | READ, then SENSITIVE_ACTION | Eve reads the exact draft back ("email to Leo: '...'. send it?") and jabby sends exactly that only after a yes |
| "text stephen hung saying ...", "imessage leo that ..." | `contacts.find` then `messages.send` | READ, then SENSITIVE_ACTION (voice only) | from your own Messages app, see [MESSAGES.md](MESSAGES.md) |
| "run git log --oneline in eigenwife" | `shell.run` | SENSITIVE_ACTION | exact command read back, one dir, 60s default timeout, destructive patterns refused before she asks |

Ambiguous asks get one clarifying question and the next thing you say is taken as the answer (90s): "ship it" -> "ship what, exactly?", a code ask with no repo anywhere -> "which repo? like eigenwife, jabby?", a send with no recipient -> "who's it going to?".

## Voice phrases to try

- "what am i working on"
- "find my resume" / "where's the OVERLAY.md file"
- "what's in package.json" / "summarize my notes.md"
- "run the tests" / "git status"
- "add a hello function with a test" (in a repo you have open) / "fix the flaky gate test in eigenwife"
- then "yeah" / "nah" to "merge it and push?"
- "what's due this week" / "check my email" / "any new internships"
- "remind me to stretch at 5"
- "email leo saying friday works at 7" -> hear the draft -> "yeah send it" or "nah"
- "run git log --oneline in eigenwife"

## Work context

`work/context.ts` probes every 4s (core side, `EVE_WORK_POLL=0` turns it off):

1. frontmost app: `lsappinfo` (no permissions),
2. window title, only for editors and terminals: System Events (Accessibility; `EVE_WORK_TITLES=0` turns it off),
3. the repo behind it:
   - Cursor / VS Code / Windsurf / Zed / Xcode: workspace name from the title, matched against repos under the code roots, else the editor's `storage.json` last folder,
   - Terminal / iTerm2: the front tab's tty (AppleScript), the foreground process on it (`ps -t`), its cwd (`lsof -d cwd`),
   - other terminals: a path in the title, else the most recent Claude Code session cwd (from the hook),
4. git facts: branch, dirty file count, last commit.

It emits `work.context {app, title?, repo?, repoPath?, branch?, dirty?, lastCommit?}` when anything changes and keeps the world slot `work.working_on` ("eigenwife (main, 3 dirty files) in Cursor") so every prompt knows. Private apps (password managers, Messages, Mail, FaceTime, Signal, WhatsApp, banks and brokerages, Wallet, Health) become `{app:"private app", private:true}`: no title is read, no repo resolved. Screen contents and accessibility text beyond a window title are never read by the work module (screen awareness is a separate, pausable module: docs/SCREEN.md).

Code roots: `EVE_CODE_ROOTS` (comma list), default `~/dev, ~/code, ~/projects, ~/src, ~/Developer, ~/Documents/GitHub, ~/Documents`. A repo is any direct child with a `.git`.

## Claude Code sessions

`watcher/claude-hook.ts` now also posts `work.claude {event: prompt|tool|test|stop, cwd, sessionId, tool?, ok?}` (cwd and session id only, never prompts or file contents; `test` is a Bash test command's pass/fail read from its output). When one of your sessions that actually used tools stops, Eve says one line ("claude's done in eigenwife.", or "... but the tests are failing."), with manners:

- only after she's born, never while attention is paused, at most once per 90s,
- never while you type: if an editor or terminal is frontmost and the last keyboard/mouse input was under 4s ago (`HIDIdleTime` from `ioreg`, unprivileged), she waits, up to 45s, then drops the line,
- not while she or you are talking,
- never for her own runs (anything under `~/.eve/work`).

## Safety rules

- **Permission classes** above are fixed per action kind; the gate only ever raises them. Anything with send / message / email / text in the kind is SENSITIVE regardless.
- **Spoken approval** for EXTERNAL_SIDE_EFFECT and SENSITIVE_ACTION: 30s of silence is a no. `shell.run`, `code.merge` and `jabby.send` use an exact `confirmLine` (the command, "merge it and push to main?", the message body) that is spoken verbatim, never paraphrased by the persona brain.
- **Refusals before asking** (`ActionDef.refuse`, checked with the deny list, so no question is even asked):
  - shell: `rm -r/-f`, force pushes (`-f`, `--force*`, `+ref`), `git reset --hard`, `git clean -f`, `git checkout -- .`, `branch -D`, history rewrites, `sudo/su/doas`, disk utilities, `dd`, `shutdown/launchctl/...`, `curl|sh` and friends, recursive chmod/chown, `killall/pkill`, fork bombs, `security` (keychain), `defaults delete`, `crontab -r`, `osascript`, `eval`, `find -delete`, `xargs rm`, `truncate/shred`, publishing packages, multi-line commands, and any argument that is a denied path,
  - files: denied paths (below), executables for `files.open`,
  - code.merge / code.keep: only Eve's own worktrees (`.../work/worktrees/...`) on `eve/*` branches.
- **Denied paths** (after resolving symlinks): `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.docker`, `~/.password-store`, `~/.config/{gcloud,gh,op}`, `~/Library/{Keychains,Messages,Mail,Cookies,Accounts,Safari}`, password manager and browser profile dirs, `/Library/Keychains`, and any file named `.env*` (except `.env.example/.sample/.template`), `.netrc`, `.npmrc`, `.pypirc`, `id_*`, `*.pem/*.key/*.p12/*.kdbx/...`, `credentials*`, `secrets*`. Anything read is passed through `redactSecrets` (API keys, GitHub/Slack/AWS/Google tokens, JWTs, private key blocks, `password=...` style assignments).
- **Code**:
  - matt's checkout is never touched: work happens in `~/.eve/work/worktrees/<repo>/<slug>` on a new `eve/<slug>-<stamp>` branch from the current branch's commit,
  - Claude runs with `--permission-mode dontAsk`: file tools plus test/build/`git status|diff|log` commands only; `git commit/push/reset/checkout`, `rm`, `sudo`, web tools are disallowed; 15 min timeout (`EVE_CODE_TIMEOUT_MS`), model `EVE_CODE_MODEL` (default sonnet),
  - one squashed commit, message from the ask, lowercase, **no attribution** (Co-Authored-By, "Generated with ...", robot emoji lines are stripped even if Claude committed them itself),
  - rebase onto `origin/<base>` (fetched) and `git push origin HEAD:<base>`, never forced: a rejected push or a rebase conflict is an honest failure and the branch stays,
  - no remote: the commit stays on the branch, nothing is pushed,
  - worktrees are removed at the end; the branch is deleted (`-d`, never `-D`) only after a successful push.
- **jabby**: every relay says READ ONLY / may act but never message others / DRAFT ONLY / send EXACTLY this. A send only happens after Eve read the draft back and you said yes.
- **Budget**: every non-READ action spends from `EIGEN_ACTION_BUDGET` (default 25 per session).
- **Trace**: every request, decision and result is in `GET /api/agency/trace`.

## HTTP

| Route | |
|---|---|
| `GET /api/work/context[?fresh=1]` | latest work context + the one-line description |
| `POST /api/work/ask {text}` | same path as a spoken ask (approvals still apply, answered by voice / keys / `action.approval`) |
| `POST /api/agency/act {kind, args}` | any single work action through the gate |

## Events

| Event | From | What |
|---|---|---|
| `work.context` | work (or any sensor) | frontmost app + repo facts, on change |
| `work.claude` | claude-hook | Claude Code session activity (cwd, tool, test result, stop) |
| `work.task` | code.task / work | `starting, working, testing, review, merging, done, failed, kept`: drives the overlay chip ("working on · add hello (eigenwife)") |
| `swarm.plan/spawn/status/progress/done` | code.task | one CODER worker so the run shows up in the swarm scene |
| `task.start/done` | work | `brain:"claude-code"` |

## Files

| File | What |
|---|---|
| `packages/core/src/work/module.ts` | `workModule()`, `createWork()`: poller, `work` service (`handle`, `claims`, `awaiting`, `resolveRepo`, `context`), claude session lines, routes |
| `work/intent.ts` | `readWorkIntent(text)` -> WorkAsk, `answerClarify` |
| `work/context.ts` | frontmost app, window title, editor/terminal -> repo, `describeWork`, `hidIdleSeconds` |
| `work/repo.ts` | code roots, repo listing + resolution from speech, git facts, test command detection, test verdicts |
| `work/code.ts` | worktree lifecycle, Claude Code args + stream parsing, diff stat, tests, attribution-free commit, rebase + push |
| `work/jabby.ts` | jabby relay (SSE), mode headers, draft parsing, `speakable` |
| `work/safety.ts` | denied paths, secret redaction, destructive command patterns, private apps |
| `work/exec.ts` | the real process runner (`AgencyDeps.exec`): argv only, timeout, capped output, line streaming |
| `agency/actions/{files,code,jabby,shell,work}.ts` | the ActionDefs; `WORK_ACTIONS` is registered in one line in `agency/module.ts` |

## Extending

Add an action: write an `ActionDef` in `agency/actions/` with the lowest honest permission class, `describe` (spoken), `targets` (apps/hosts for the deny list), `refuse` (hard no's, checked before asking), `confirmLine` if the exact words matter, and a `run` that only uses `env.deps.exec/fetch/osa` (so tests can fake it). Add it to `WORK_ACTIONS`. Then teach `work/intent.ts` the phrasing, route it in `createWork().handle`, and add a row to `packages/core/test/work.test.ts` for the class, the intent and the refusal.

## Tests

`bun test packages/core/test/work.test.ts`: hermetic (fake claude, fake jabby SSE, fake mdfind/open/zsh; real git only in tmp dirs, pushes go to a tmp bare repo). Covers permission classes, approvals before merge / send / shell, silence = no, destructive command table, denied paths (incl. symlinks), redaction, private apps, repo resolution from speech and context, editor title parsing, the context probe, intent table + non-work phrases, clarify round trip, reflex escalation, the full worktree lifecycle (attribution squashed away, rebase over new upstream work, no force), yes / no / declined / failed / red-tests paths through the work service, the jabby read / draft / send / remind / offline paths, the hook's work events, and the session-finished line with focus, pause and own-run rules.

Real run on the dev Mac (2026-09-26): in a throwaway `hello-repo` under `$TMPDIR` (no remote), "add a hello function with a test" went end to end through real headless Claude Code in 35s (worktree, `hello.js` + `hello.test.js`, `bun test` 2 pass, spoken summary, "commit it onto eve/...? there's no remote to push to", simulated "yeah"), leaving one commit `add a hello function with a test` by matt with no trailer on `eve/hello-function-test-*`, main untouched, worktree removed, temp dir deleted. `files.search` for OVERLAY.md found `~/dev/eigenwife/docs/OVERLAY.md`. `jabby.ask` "what's due this week" came back from the live daemon read-only via syla.
