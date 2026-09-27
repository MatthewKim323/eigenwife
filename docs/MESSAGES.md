# Messages

Eve texts people for you from your own Messages app. She finds them in Contacts, drafts the text in your voice (or keeps your exact words), reads the recipient and the exact text back, and sends only after you say yes out loud.

```
 "hey can you text my friend stephen hung"
   work intent: messages.send {who:"stephen hung"}
   contacts.find   READ    matched inside osascript, only candidates come back
     one match      -> go on
     several        -> "stephen hung or stephen lee?"   (next thing you say picks)
     none           -> "i can't find stephen hung in your contacts."  (never guesses a number)
   no text yet      -> "what do you wanna say to stephen?"
   draft            dictated words kept as-is (lowercased), otherwise the brain writes it in your voice
   messages.send   SENSITIVE_ACTION, voice-only
     she says: text to stephen hung: "yo you up". send it?
       "make it shorter" / "add that i'm bringing snacks" / "say 'omw' instead"
            -> this draft is a no, she re-drafts and reads the new one back (fresh approval)
       "yeah" / "send it"   -> her cursor glides to Messages, AppleScript sends, "sent."
       "nah" / 30s silence  -> "okay, not sending it."
```

## Voice phrases

| Say | What happens |
|---|---|
| "text my friend stephen hung" | finds him, asks "what do you wanna say to stephen?" |
| "text stephen 'yo you up'" / "text stephen saying yo you up" / "imessage leo: omw" | your exact words |
| "text stephen that i'm running late" / "message my mom that i'll be home by 8" | drafted in your voice ("running late") |
| "text stephen asking if he wants to get food" | drafted ("u tryna get food?") |
| "send a text to jess and tell her i'm outside" | drafted |
| (after "stephen hung or stephen lee?") "stephen lee" / "lee" / "the second one" / "the one ending 0102" | picks that one; "never mind" drops it |
| (after the read-back) "yeah" / "yep" / "send it" | sends |
| "nah" / "wait" / "cancel" / silence | nothing is sent |
| "make it shorter" / "make it more casual" / "take out the lmk" / "don't mention dinner" | brain rewrites, she reads it back again |
| "add that i'm bringing snacks" / "also say i'll be there at 8" | appended, read back again |
| "say 'on my way' instead" / "change it to on my way" | your words replace the draft |

Starters she recognizes: text, txt, message, imessage / "i message", sms, "send a text/message to", "shoot a text to", "drop a text to". "text me ...", "text him back", and anything "on discord / slack / email / instagram / whatsapp" are not Messages texts ("email leo saying ..." still goes to jabby, see [WORK.md](WORK.md)).

## Safety

- **Spoken yes only.** `messages.send` is `SENSITIVE_ACTION` with `voiceOnly`: the gate ignores `Enter`/`y` keys and any other module's `action.approval {approved:true}` for it. Keys, buttons and other modules can still say no. 30s of silence is a no.
- **Exact read-back.** `confirmLine` is `text to <name>: "<exact text>". send it?`, spoken verbatim (never paraphrased). The approval covers those words and that recipient only.
- **Fresh approval every time.** Every draft (including every edit) is a new `messages.send` request with its own `actionId` and its own question. An edit while she waits ("yeah add that...") is caught before the gate's yes/no check and emitted as `action.approval {approved:false, by:"voice"}` for that draft, so a yes-word inside an edit never sends the old text.
- **Contacts only, never raw numbers.** A send needs a Contacts card id and a handle; right before sending, the card is read again and the handle must be on it (formatting ignored: `+1 (949) 555-0101` == `9495550101`). Anything else is refused.
- **Rate limit.** 5 texts per 10 minutes (`EVE_MESSAGES_MAX`, `EVE_MESSAGES_WINDOW_MS`). Over the limit is refused before she asks.
- **Length.** Empty texts and texts over 1000 characters are refused before she asks.
- **Privacy.** The whole address book is matched inside the `osascript` process (the matcher's source is pasted into the JXA); only the candidates for this send (name, phones, emails) come back. Other people's details never leave Contacts.app. Reading replies is out of scope: no `chat.db`, no Messages windows (work context already treats Messages as a private app).
- **Budget + trace.** Sends spend from `EIGEN_ACTION_BUDGET`. Every lookup, question, decision and send is in `GET /api/agency/trace` (the trace holds the text and handle; it lives in memory on your machine only).
- **No em dashes** in anything she drafts: they are swapped for commas.

## How the send works

`SEND_APPLESCRIPT` in `agency/actions/messages.ts` is a constant. Your words only travel as argv (`osascript -e <script> eve <handle> <text> <iMessage|SMS> <dry>`); item 1 is a fixed sentinel so a text starting with `-` can never be read as an osascript flag. It picks the first enabled account of that service type, gets `participant <handle>` on it, and `send`s.

- **iMessage first.** If that errors for a phone number (no iMessage account signed in, participant lookup fails), it retries once through the SMS account (iPhone Text Message Forwarding). Email handles never fall back. Note: Messages accepts an iMessage send to a number that isn't on iMessage and only fails later (red "not delivered"); AppleScript can't see that, so "sent" means Messages took it.
- **Honest results.** "sent." only after the AppleScript returns ok. Otherwise "didn't send: ..." with the reason (not allowed to control Messages, not signed in, ...).
- **Her cursor** (docs/AGENT_CURSOR.md): `cursorApp: "Messages"`, so when the overlay's cursor layer is watching, her cursor glides to the Messages window (bounds only) or its Dock icon and clicks, after your yes and just before the AppleScript runs.
- **Dry run.** `EVE_MESSAGES_DRY_RUN=1` does everything (lookup, read-back, approval, account + participant lookup) and returns before `send`: "dry run, didn't actually send it."

## Permissions (first use)

macOS asks once for each, for whatever runs the core (your terminal, or the Eigenwife app):

1. **Contacts**: "... would like to access your contacts" (Privacy & Security > Contacts). Without it she says "i'm not allowed into Contacts yet".
2. **Automation > Contacts**: "... wants to control Contacts".
3. **Automation > Messages**: "... wants to control Messages". Without it: "i'm not allowed to control Messages yet".

Messages must be signed in to iMessage (and, for the SMS fallback, Text Message Forwarding enabled on your iPhone).

## Files

| File | What |
|---|---|
| `packages/core/src/agency/contacts.ts` | `scoreContactRows` (fuzzy: exact, sound-alike like stephen/steven, prefix, one typo, nicknames), the two constant JXA scripts, `findContacts`, `contactHandles`, `pickContact`, `whichQuestion`, `chooseOption`, `bestHandle` (mobile, then any phone, then email) |
| `packages/core/src/agency/actions/messages.ts` | `contacts.find` + `messages.send` (`messagesActions()`, registered in `agency/module.ts`), `SEND_APPLESCRIPT`, drafting (`draftMessage`, `applyEdit`, `fallbackDraft`), and `createMessagesFlow` (which-one / what-to-say questions, read-back + edit loop) |
| `packages/core/src/work/intent.ts` | `readMessageAsk` ("text X saying/that/asking ..."), `readDraftEdit` |
| `packages/core/src/work/module.ts` | routes `messages.send` asks and answers to the flow; `awaiting()` covers her messages questions |
| `packages/core/src/agency/gate.ts` | `voiceOnly` approvals |
| `packages/core/src/reflex/intent.ts` | a draft edit counts as an answer to a pending approval, so the reflex leaves it to agency instead of chatting |

## Tests

`bun test packages/core/test/messages.test.ts`: hermetic (fake osascript with a fake address book running the real matcher, fake brain, fake speech). Covers intents and non-intents, edit phrases, contact matching one / many / none / no handle / same-name twins / sound-alikes / nicknames, the which-one question and answers, the "what do you wanna say" follow-up, dictated vs drafted texts, read-back wording, edit loop (append, rewrite, replace, a yes-word inside an edit), no answer / no / Enter / other-module yes all sending nothing, AppleScript injection (constant script, argv only, sentinel), spoofed and raw numbers, rate limit and its window, SMS fallback (phones only), Contacts / Messages permission errors, dry run, and the cursor glide order.

Verified on the dev Mac (2026-09-26), no message sent: the Contacts lookup ran for real ("stephen" -> 3 candidates, "stephen hung" -> one pick, counts only, nothing printed); `SEND_APPLESCRIPT` compiles with `osacompile`; the dry run found the enabled iMessage and SMS accounts and resolved a participant through both, with a hostile text (`-e x" & (do shell script ...) & "`) passed safely as argv.
