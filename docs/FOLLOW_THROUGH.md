# Follow-through

Eve carries a task through like a person would: she acts, says how it went in one line, asks the natural next question, and keeps going when you answer. She never goes quiet after doing something, and she never reads a file out loud unless you ask.

```
 "find me ramen places in san francisco"
   work intent browse.options -> followup.browse
     browser.task (her browser, Google Maps)        SAFE_ACTION, no question
     options off HER page: name, rating, reviews, price, kind, address, hours
     her pick: memory + profile (brains.quickJson), else rating / budget / a word you like
   "found 3: Mensho Tokyo SF, 4.6, mid; Marufuku Ramen, 4.5; Nagi Ramen, 4.4, cheap.
    i'd do marufuku ramen, it's got the spicy thing you like. which one?"
   followup.pending (choice)                       world slot followup.pending
 "the second one"   (or "marufuku", "the spicy one", "the cheaper one", "yeah" = her pick)
   browser.task on that place, hours off the page
   "pulled up marufuku ramen, open till 10 pm. want me to look for a table?"
 "yeah"
   browser.task on OpenTable's public search (tonight, 2 people), times next to its name
   "they have 7:30, 8:15 or 9:00, want 7:30?"
 "yeah"  (or "8:15 then")
   browser.submit  EXTERNAL_SIDE_EFFECT, approved by that spoken yes (no second question)
   "booked marufuku ramen at 7:30. want it on your calendar?"
   (or, when the site wants your details: "i grabbed 7:30 at marufuku, but it wants your
    name and number to finish. it's up in my browser. want it on your calendar?")
 "yeah"
   calendar.create_event (Google via Zo, else Calendar.app), same spoken yes
   "on your calendar, 7:30 at marufuku ramen."
```

```
 "find my resume"
   files.search (ranked, below) -> clear winner -> files.open (SAFE_ACTION)
   "found matt_kim_resume.pdf in downloads, opening it."
   close top two -> "found two. the one from august or the older one from march?"
     "the older one" / "the august one" / "the one in downloads" / "the second one" -> opens it
   "where's my resume" -> "resume.pdf, in documents. want me to open it?"
   then, only if you ask: "read it" / "what does it say" (files.read summary), "the other one",
   "show it in finder" (open -R), "send it to leo" (jabby draft, read back, send on yes)
   a failed open: "found X in downloads but couldn't open it. want me to show it in finder?"
```

Code tasks keep their own next question ("merge it and push to main?", docs/WORK.md).

## Files that feel human

`packages/core/src/work/find.ts`, used by `files.search`, `files.open` and `files.read` name lookups.

- **Where**: Spotlight under home, scored by scope: `~/Documents` (6), `~/Downloads` (5.5), `~/Desktop` (5), iCloud Drive `~/Library/Mobile Documents/com~apple~CloudDocs` (5), anywhere else in home (1). An explicit folder (`dir`) searches only there.
- **Out**: code roots (`~/dev`, `~/code`, `~/projects`, `~/src`, `~/Developer`, `~/Documents/GitHub`, `~/repos`, ...) unless he names a repo; inside any git repo its `test`, `tests`, `spec`, `dist`, `build`, `out`, `target`, `vendor`, `examples`, `public`, `assets` folders; anywhere: `node_modules`, `fixtures`, `__fixtures__`, `testdata`, `__tests__`, `__snapshots__`, `coverage`, caches, `venv`; hidden folders; `~/Library` except iCloud Drive; the Trash; denied paths (docs/WORK.md).
- **Score**: whole query in the file name +10 (part of it +4 x fraction, content only -2); for document-ish asks (resume, cv, essay, transcript, invoice, notes, deck...) pdf/docx/doc/pages/key/pptx/rtf +5, md/txt +2, sheets +1, code -8, images -2; recency `4 x 0.5^(days/120)`; his name in the file name (from the user profile) +2; `copy` / `(1)` / `old` / `backup` -1; a document inside some git repo -4.
- **Dedupe**: same stem (minus ` (1)`, ` copy`, `final`, `v2`) and size counts once.
- **Ask or open**: the top two are both file-name matches of the same kind within 3 points: ask (by month when they're more than 20 days apart, else by folder, else by name). Otherwise open the top one.
- **Never read aloud** by default: `find` opens, `where` locates. Contents only on "read it", "what does it say", "summarize it" (a 1-3 sentence summary, secrets redacted).

## The follow-up

`packages/core/src/followup/` (module `followup`, service `followup`).

| State | What she asked | What resolves it |
|---|---|---|
| `choice` | "which one?" over 2-5 options | an ordinal ("the second one", "last one"), a name (fuzzy, for speech-to-text: "marafuku"), an attribute ("the cheaper one", "highest rated", "most reviews", "the spicy one", "the one from august", "the older one", "the one in downloads"), "yeah" (her pick), "nah" / "none of them" |
| `confirm` | a yes/no on one concrete next step (`next`: open, hours, availability, book, calendar, reveal, open) | "yeah" / "sure" / "book it" / "go for it", "nah", a time she offered ("8:15 then"), or a different step ("are they open late", "put it on my calendar") |
| `none` | nothing, but she remembers what she just did ("opened matt_kim_resume.pdf") | "read it", "the other one", "show it in finder", "send it to leo", short corrections ("no the older one") |

- **Expiry**: about 2 minutes (`ttlMs`, default 120000) with no answer, or as soon as he says something else (a 3+ word utterance that doesn't resolve it). Fillers ("hmm", "ok") don't count as a new topic.
- **World slot** `followup.pending`, in every prompt, so any engine (the talker, Eve Live, the thinker) knows what her last line was waiting on: `asked "which one?" (ramen places in san francisco); options: 1 Mensho Tokyo SF 2 Marufuku Ramen 3 Nagi Ramen. his answer ("the second one", a name, "the cheaper one") picks one`.
- **Service** (`services.ts FollowupService`): `pending()`, `claims(text)` (pure), `resolve(text, {parent})` -> `{handled, ok, summary}`, `offer(...)`, `clear(reason)`, `browse(query)`, `noteBrowse(run)`.
- **Routing**: the reflex has two additive hooks. `talkerSkips` returns true when `followup.claims(text)` (no fresh talker reply for an answer), and `judge` turns such an utterance into ESCALATE (even outside the 25s conversation window). ESCALATE goes to `work.handle`, which asks `followup.resolve` first. The summary comes back and the reflex says it (verbatim when it's 32 words or fewer). A gate approval that's waiting ("yeah" to "put it on your calendar, yeah?") still wins: the hooks only run when no approval is pending. Any other engine can call `ctx.use("followup").resolve(utterance)` directly.

### Safety

- Browsing is `browser.task` (SAFE_ACTION). Anything that commits goes through `browser.submit` (EXTERNAL_SIDE_EFFECT). `browser.task` itself still stops before any POST form, Enter in a POST form, or Book / Reserve / Pay / Confirm button and asks (docs/AGENT_CURSOR.md).
- The booking and the calendar event pass `approved: {text, question}` to `agency.act`: his exact words and the exact question she asked ("they have 7:30, 8:15 or 9:00, want 7:30?"). The gate records that as his spoken approval (`action.approval {by:"voice"}`, the trace reason quotes both) instead of asking the same thing twice. Deny list, budget and `refuse` still run first.
- The gate **ignores** a pre-approval for `SENSITIVE_ACTION` (sends, messages, payments, purchases): those always get the gate's own question. `jabby.send` from "send it to leo" reads the draft back and waits for a yes as before.
- No yes, no booking: "nah", silence past 2 minutes, or a new topic leaves nothing booked.
- Her page only: options come from `read` on HER browser (docs/AGENT_CURSOR.md), never matt's screen.

### Never quiet

Every action gets an outcome line. Work asks and follow-up steps return theirs to the reflex (they run inside `reported()`, an AsyncLocalStorage context, so the follow-up module knows someone else will speak). For actions outside that (the reflex's own "show me ramen places near irvine" browse, a music or quit command that failed), the follow-up module listens to `action.result`:

- `browser.task` ok with options on the page: the same "found 3 ... which one?" line and a `choice` pending; a single place: "that's marufuku ramen, open till 10 pm. want me to look for a table?"; any other page: "it's up in my browser."
- a failed `music.play`, `music.control`, `app.quit`, `files.open`: one line ("couldn't get spotify to play that. is it open?"). Declined actions ("not done: ...") aren't failures and get nothing extra.
- The browse that runs beside "figure out tonight" (the show) passes `followup: false`: its task summary is the answer.

## Option extraction

`followup/options.ts`, pure. `browser.task` puts `data.options` on every run.

- **Cards first**: the Playwright read also returns listing tiles (`cards`): Google Maps feed articles (the aria-label is the place name), else `article` / `li` / card elements with a heading. Aria-labels inside a card (`4.7 stars 1,234 Reviews`, `Price: $$`) are appended to its text. Tiles with no rating, price or hours (nav) are dropped.
- **Text fallback**: a rating line (`4.5(3,211)`, `4.5 (3.2k reviews)`, `4.6 stars`) anchors each listing, the nearest name-looking line above it is the name, the lines after it are the details. Works for Maps lists, Yelp and most "best X in Y" pages.
- Each option: `name, rating, reviews, price ($$ or $20-30), kind, address, hours, url, detail` (lowercased text for "the spicy one").
- **Backup**: fewer than 2 options off the page (captcha, layout change) falls back to `places.search` (Zo Maps / web), else "it's up in my browser, but i couldn't make out a clean list".
- **Times**: `extractTimes` reads `7:30 PM`, `8:15pm`, `19:45` near the restaurant's name on the reservation page; `pickTime` matches "8:15", "the 7:30", "9 pm".

## Events

| Event | What |
|---|---|
| `followup.pending {id, domain, expect, question, options[{n,name,detail?}], next?, expiresAt}` | she's waiting on his next step |
| `followup.resolved {id, utterance, step, choice?, by}` | his answer picked / confirmed / declined (`by`: ordinal, name, attribute, yes, no, step) |
| `followup.cleared {id, reason}` | done, declined, expired, topic, replaced |

`GET /api/followup` returns the live pending state.

## Files

| File | What |
|---|---|
| `packages/core/src/work/find.ts` | scopes, exclusions, scoring, dedupe, `ambiguity` |
| `packages/core/src/agency/actions/files.ts` | `files.search` ranked (`data.hits` with score and `where`), `files.open {reveal:true}` = show in Finder |
| `packages/core/src/followup/options.ts` | option extraction, `resolveChoice`, times |
| `packages/core/src/followup/module.ts` | pending state, `classify`, the places and files flows, outcome lines |
| `packages/core/src/followup/report.ts` | `reported()`: who speaks an outcome |
| `packages/core/src/work/intent.ts` | `browse.options`; `files.search` mode `open` (find) vs `locate` (where) |
| `packages/core/src/agency/gate.ts` | `preApproved` (never for SENSITIVE_ACTION) |
| `packages/core/src/agency/browser/playwright.ts` | `cards` in `read` |

## Tests

`bun test packages/core/test/followup.test.ts`, hermetic (fake mdfind / open, a fake browser serving fixture pages, fake Calendar):
ranking (resume in Downloads beats `~/dev/.../test/fixtures`, caches, node_modules and repo tests are out, name beats content, a named repo is searched, duplicates collapse), open vs ask on close matches, "find my resume" opens and reads nothing, "the older one" opens that one, "read it" / "the other one" / "show it in finder", "where's my resume" then "yeah", a failed open still gets a line; option extraction from Maps text, Yelp text and cards (with aria ratings); answers by ordinal, name (fuzzy), attribute, month, folder; the full places flow (find, pick, table, "yeah" books 7:30 with the trace showing his yes to her exact question, calendar at 19:30), "8:15 then" books 8:15, "nah" books nothing, the gate refusing a pre-approval for a send and still asking for a bare submit; the reflex's own browse getting a "which one?" line; expiry at 2 minutes; topic change vs filler vs answer; classify for yes/no/steps; the reflex hook escalating an answer to work; failed actions nobody reports getting a line, reported ones not.

Real run on the dev Mac (2026-09-26): a real ranked Spotlight search for "resume" put three of matt's actual resumes on top (Downloads, then two in iCloud Drive), nothing from `~/dev`, and would have asked "the one in downloads or the one in icloud?" (nothing was opened). Her browser (a throwaway profile) read Google Maps for "ramen in san francisco": 12 cards on the page, 5 options with name, rating, review count, price and hours (Denya Ramen 4.7 / 78 / $20-30 / open till 10 PM, Mensho Tokyo SF 4.5 / 3480, HINODEYA 4.8 / 921, ...), and the line "found 3: Denya Ramen, 4.7; Mensho Tokyo SF, 4.5; HINODEYA Ramen & Bar Chestnut, 4.8. i'd do hinodeya ramen & bar chestnut, best rated of the bunch. which one?". Nothing was booked; the browser was closed.
