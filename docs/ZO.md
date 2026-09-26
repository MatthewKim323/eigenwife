# Zo

Eve has her own computer: a [Zo](https://zo.computer) machine ("jabby's Zo", `https://jabby.zo.computer`) with matt's Google Calendar (`matthewykim23@gmail.com`) and Spotify connected. With `ZO_API_KEY` in `.env`, the core uses it for four things:

| What | Zo tool | Where in the core |
|---|---|---|
| Her state lives on her machine, and comes back after a laptop wipe | `write_file`, `read_file`, `list_directory` | `home/zo.ts`, `home/module.ts` |
| Booking on matt's real Google Calendar, reading his evening | `use_app_google_calendar` | `agency/actions/calendar.ts` |
| Finding real places tonight | `maps_search` | `agency/actions/places.ts` |
| Knowing what song is on, even on his phone | `use_app_spotify` | `zo/spotify.ts` |

All four go through one client (`packages/core/src/zo/`). Without a key nothing changes: macOS Calendar, web search, local files.

## Latency rule

Zo is slow next to speech: ~150ms for a JSON-RPC ping, 1.5-5s for a tool, 5-7s for Maps, ~5s for `/zo/ask`. **Zo never sits on the speaking path.**

- The MCP session is opened at boot in the background (`client.warm()`) and kept alive with a `ping` every 4 minutes, so no real call pays for `initialize`.
- Every call has its own timeout and resolves (never throws, never emits `error` on the bus). Failures show up in `/api/home/status` (`zoStatus.lastError`) and the log.
- At most 2 calls in flight. Background work (home sync, Spotify poll) may hold only one lane, so a booking or Maps search always has a free lane, and high-priority calls jump the queue.
- Home sync is debounced (1.5s) and skips files Zo already has. The Spotify poll has its own timer. Maps runs inside the swarm's PLACES agent, in parallel with CALENDAR and MEMORY.
- Maps results are cached per query for 10 minutes. Once she is born, home prefetches `cheap spicy food` and `cheap spicy ramen` (open now, inexpensive) near `EIGEN_LOCATION` and refreshes every 9 minutes, so "figure out tonight" usually hits a warm cache (0ms instead of ~7s).
- Booking has a hard 8s cap (`EVE_ZO_BOOK_CAP_MS`). Past it, macOS Calendar books instead, and if the slow Google event lands later it is deleted so there is no duplicate. Free/busy has the same 8s cap.
- The only thing that waits on Zo is the boot-time restore, and only when `~/.eve` is empty, capped at 15s.
- `test/zo.test.ts` asserts that nothing under `speech/`, `reflex/`, `mind/` or `ears/` imports or uses the Zo client, and that a hung Zo does not hold up boot or the bus.

## Wire protocol (verified live 2026-09-26)

- `POST https://api.zo.computer/mcp`, `Authorization: Bearer $ZO_API_KEY`, `Accept: application/json, text/event-stream`. JSON-RPC 2.0. `initialize` returns an `mcp-session-id` header, sent back as `Mcp-Session-Id`. Server `zo-tools`, protocol `2024-11-05`, 81 tools. Responses were plain JSON in practice; the client also reads SSE `data:` frames (multi-line data joined). In practice the server does not enforce the session (a bogus id still works), but the client re-initializes once on a 404/400 anyway.
- `POST https://api.zo.computer/zo/ask {"input": "..."}` -> `{output, conversation_id}`, ~5s. Only used as the mirror's fallback.
- Tool results are MCP `content` text. Tool failures are `isError: true` with text `Error: ...\ncode: <code>` (`invalid_path`, `read_failed`, `action_failed`, `tool_not_found`, ...).
- App tools (`use_app_*`) answer with a Python repr, not JSON: `exports={'$summary': '...'} os=[] ret=<value> stash_id=None t={...}`. `zo/repr.ts` parses that (dicts, lists, tuples, quoted strings, numbers, `True/False/None`, `Name(k=v)` calls). The useful part is `ret`.
- Paths must be absolute. The workspace (what the Zo UI shows) is `/home/workspace`; the bash tool's `$HOME` is `/root`. Eve's folder is `/home/workspace/eve` (`ZO_EVE_DIR` to override).
- `read_file` returns a JSON array `[content, "kind='file_ref' path=..."]`. A 114KB file round-trips intact with `read_entire_file: true`.
- `bash` takes `{cmd}`, not `{command}`.

### App tools Eve uses

Discovered with `list_app_tools {app_slug}` (the args live there; `tool_docs` only knows top-level tools).

| tool_name | configured_props Eve sends | Notes |
|---|---|---|
| `google_calendar-create-event` | `calendarId:"primary", summary, eventStartDate, eventEndDate` (RFC3339 with offset), `timeZone:"America/Los_Angeles", location, description, addSelfAsAttendee:false, sendUpdates:"none"` | `ret` is the event: `id`, `htmlLink`, `status`, `start.dateTime` |
| `google_calendar-get-event` | `calendarId, eventId` | a deleted event comes back with `status:"cancelled"` |
| `google_calendar-list-events` | `calendarId, timeMin, timeMax, singleEvents:true, orderBy:"startTime", fields:"compact", maxAttendees:1, q?` | `ret` is a list; all-day events have `start.date` |
| `google_calendar-delete-event` | `calendarId, eventId` | |
| `google_calendar-query-free-busy-calendars` | `calendarId:["primary"]` (an array: a string fails with `parseObject(...).map is not a function`), `timeMin, timeMax, timeZone` | `ret.calendars.primary.busy[]`; no titles, so `calendar.free_busy` uses list-events |
| `spotify-get-currently-playing-track` | `{}` | nothing playing: `ret={'playing': False}`; playing: Spotify's object (`is_playing, progress_ms, item{id,name,artists,duration_ms}`) |

`maps_search {query, location, open_now:"true", price_level:"PRICE_LEVEL_INEXPENSIVE"}` returns a JSON array of strings; one is `summary="..." places=[MapPlace(title=..., uri=..., rating=None, price_level=None, ...)]`. The structured fields are usually empty and half the entries are "Review of X" links, so `parseMapsSearch` drops reviews, strips " - Google Maps", and pulls rating (`4.4-star`), price range (`$10-20`, cost = midpoint), a spicy dish and a short `why` out of the summary prose.

## Home on Zo

Mirrored to `/home/workspace/eve/`: `profile.json`, `preferences.json`, `relationship.json`, `memories.jsonl`, `memories.md` (readable top 60 by importance), `task_state.json`, `status.json` (at most once a minute). `embeddings.json` stays local.

- Debounced, coalesced, and a file whose bytes Zo already holds is skipped. `write_file` over MCP on the low lane; if that fails, one `/zo/ask` writes the files. Files that still fail stay dirty for the next write.
- `lastSyncAt` is recorded; once a sync succeeds `home.status.host` is `"zo"`.
- **Restore**: on boot, if none of profile/preferences/relationship/memories/task_state exist in `~/.eve`, home lists her Zo folder, reads each file back (JSON validated, invalid ones skipped) and writes it locally before memory and preference load. Restored bytes are marked as already on Zo, so nothing echoes back. `EVE_ZO_RESTORE=0` turns it off.
- **Throwaway homes are isolated**: the Zo folder is one per Zo account, not per `~/.eve`. So mirror, restore and the Spotify poll only run for the real `~/.eve` (or `EVE_ZO_MIRROR=1`). `scripts/e2e.ts` and any `EVE_HOME=/tmp/...` run still get calendar/maps through Zo but never overwrite or pull in the real Eve.
- `eve status` pings Zo for real (initialize + ping) and shows `ZO  LIVE (ping 140ms), last sync 12s ago` or `UNREACHABLE (...)`.
- `GET /api/home/status` includes `zoStatus { connected, session, lastOkAt, lastError, inflight, queued, calls{<tool>:{n, errors, p50, p95, lastMs}} }` and, after a restore, `zoRestore`.

## Calendar

`calendar.create_event` (and the harem alias `calendar.create`) is still `EXTERNAL_SIDE_EFFECT`: Eve asks out loud and the gate waits for "yeah" before `run()` executes. With Zo, `run()` creates the event on matt's primary Google Calendar in America/Los_Angeles, with the location and a description ending "booked by Eve (eigenwife)". The observation carries the event id and `htmlLink`; `data` is `{id, uid, htmlLink, calendar:"google", via:"zo"}`. Any Zo failure, or no answer within 8s, falls back to the macOS Calendar path (`via:"macos"`).

`calendar.delete_event {id}` deletes a Google event (ids are base32hex, so a macOS UUID uid still goes to Calendar.app). `calendar.free_busy` reads Google via list-events (titles, all-day events ignored), else Calendar.app.

`EVE_ZO_CALENDAR=0` keeps calendar on macOS only.

## Places

`places.search` asks Google Maps through Zo first: query `[cheap] [likes] [cuisine or "food"]` (e.g. `cheap spicy ramen`), location `EIGEN_LOCATION` (default `Irvine, CA`), `open_now` true (tonight; `openNow:false` in args to widen), and `price_level` inexpensive when prefs say cheap or any memory mentions saving money / being broke / a budget. Results come back as `{name, price, cost, rating, address, url, why, dish, source:"zo"}` with `via: "zo:maps"` or `"zo:maps:cache"`. Empty or failed Maps falls through to the existing web search + extraction + frontier path. `EVE_ZO_MAPS=0` skips Maps.

## Spotify

Every 25s while the core runs (60s after three idle polls, exponential backoff to 5 min on errors), home polls `spotify-get-currently-playing-track` on the low lane and emits `media.play {track, artist}` (source `"zo"`) when the song changes or restarts (playhead jumped back). That is what feeds the reflex "same song on repeat" rule even when the music is on his phone. A `media.play` from any other source for the same track within 60s suppresses Zo's, so one listen is one event. `EVE_ZO_SPOTIFY=0` turns the poll off.

## Env

| Var | Effect |
|---|---|
| `ZO_API_KEY` | turns all of this on (gitignored `.env`) |
| `ZO_BASE_URL` | default `https://api.zo.computer` |
| `ZO_EVE_DIR` | default `/home/workspace/eve` |
| `EIGEN_LOCATION` | Maps location, default `Irvine, CA` |
| `EVE_ZO_CALENDAR=0`, `EVE_ZO_MAPS=0`, `EVE_ZO_SPOTIFY=0`, `EVE_ZO_PREFETCH=0`, `EVE_ZO_RESTORE=0` | turn one piece off |
| `EVE_ZO_MIRROR=1` | mirror/restore/poll even from a non-default `EVE_HOME` |
| `EVE_ZO_BOOK_CAP_MS` | booking cap before the macOS fallback, default 8000 |

## Live verification (2026-09-26, from the dev Mac)

Run through the real client and the real action code against jabby's Zo. Nothing left behind: both test events deleted and confirmed, probe files removed, a final sweep found 0 leftover "eigenwife test" events.

| Check | Result |
|---|---|
| initialize | ok, 1.5s (paid once at boot) |
| ping | p50 135ms, p95 1.3s (n=10) |
| tools/list | 81 tools, 1.2s; `write_file`, `read_file`, `maps_search`, `use_app_google_calendar`, `use_app_spotify` present |
| write + read `/home/workspace/eve/_eigenwife_verify.txt` | byte-exact round trip; write 3.4s, read 2.2s |
| `calendar.create_event` "eigenwife test (delete me)" +10 min, via the action | `via:"zo"`, 4.5s and 1.6s (an earlier raw probe took 7.9s); get-event: `confirmed`; list-events `q` found it |
| `calendar.delete_event {id}` | ok 4.1s / 5.3s; get-event after: `cancelled`; list-events: gone |
| `calendar.free_busy` action | "busy tonight: nothing. free from 5:00 PM", calendars `["google"]` |
| free-busy tool (raw) | ok, 2.3s |
| `maps_search` "cheap spicy ramen", Irvine, open now, inexpensive | 7.4s; top 3: Kitakata Ramen Ban Nai - Irvine ($10-20, spicy miso), Marufuku Ramen ($20-30, spicy tantan), Hokkaido Ramen Santouka ($10-20). Repeat calls 5.0s / 6.7s; cached call 0ms |
| `places.search` action on the warm cache | "3 places via zo:maps:cache: Kitakata Ramen Ban Nai - Irvine ($15), ..." |
| Spotify currently playing | `{playing:false}` (nothing on), 3.6s |

p50 / p95 per call (ms), one session (the create-event row also counts the earlier 7.9s raw probe):

| Call | n | p50 | p95 |
|---|---|---|---|
| ping | 10 | 135 | 1291 |
| write_file | 4 | 3366 | 4218 |
| read_file | 4 | 2726 | 3790 |
| list_directory | 1 | 1855 | 1855 |
| google_calendar-create-event | 3 | 4486 | 7870 |
| google_calendar-get-event | 4 | 3527 | 4404 |
| google_calendar-list-events | 6 | 2132 | 4873 |
| google_calendar-delete-event | 2 | 4082 | 5258 |
| google_calendar-query-free-busy-calendars | 1 | 2280 | 2280 |
| maps_search | 3 | 6719 | 7369 |
| spotify-get-currently-playing-track | 4 | 3147 | 4189 |

Takeaways: Maps is the slowest thing Eve does (~7s), which is why it is prefetched and cached. Booking lands inside the 8s cap most of the time but not always (one 7.9s sample), so the macOS fallback plus late-duplicate cleanup is load-bearing. The live numbers keep accumulating in `/api/home/status` `zoStatus.calls`.

## Tests

`bun test packages/core/test/zo.test.ts` (plus `home.test.ts`). A fake Zo MCP server on a real local port (`test/zo.fakes.ts`) serves sanitized copies of the live responses above, JSON or SSE. Covered: repr parsing, SSE framing, one initialize per session, session re-init on 404, tool error codes, timeouts, dead server, the 2-lane limit and priority, keepalive pings, RFC3339 in LA time across DST, Maps parsing and caching and shared in-flight prefetch, calendar props and parsing, mirror debounce + skip-unchanged + `/zo/ask` fallback, restore (and its 15s cap with a hung Zo), throwaway-home isolation, prefetch on birth, Spotify change/repeat/dedupe/backoff, calendar create via Zo / fallback / cap + late cleanup / delete / free-busy, places via Zo and its fallback, and the speaking-path guard.
