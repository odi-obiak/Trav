# AISA Auto Quote: test landing page

Test page for the SLM demo build. Layout follows Jill Hanks' AISA wireframe: the conversation runs inline on the
left, and a "Your quote" panel on the right shows what AISA has captured, step by step, for the customer to review
and confirm. It is read-only: Travelers doesn't want a form experience (2026-10-01).

| Piece | How | Steps |
|---|---|---|
| Inline chat | Cognigy Socket.IO client (`@cognigy/socket-client@4.9.2`) on the existing Webchat v3 endpoint. The page renders messages, quick replies and buttons itself. | 1 to 6, 8, 9 |
| Browser voice | Click To Call SDK (`@cognigy/click-to-call-sdk@0.2.0`) on the existing WebRTC endpoint. One click to call; the call transcript lands in the same conversation; the customer can type during a call. | 7, and voice for the rest |
| "Your quote" panel | 7 steps (About You, Add Vehicles, Add Drivers, Driving History, Current Insurance, Review, Your Rate). Labels and order come from Travelers' web question set (`js/questions.js`). Read-only: values come only from the conversation; the customer confirms or asks AISA to correct. | all |
| xApps | Any `xappUrl` the flow sends opens in the panel ("Shared by AISA"), in chat and voice alike. Used for the declaration page upload screen (to Azure Blob) and the simulated rate page. | 3, 8 |

Entry screen: three choices (chat, talk, upload the declaration page). No form option: Travelers ruled out a form
experience on 2026-10-01. "Talk with AISA" says it uses the computer's microphone and is not a phone call,
following the first CX study finding (people confused a browser call with a phone call).

## Run

From your own Terminal (the Claude preview runner can't read Downloads):

```bash
cd ~/Downloads/lisa-repro/landing-page && python3 serve.py
```

Then open:

- `http://localhost:5180/` for the live page
- `http://localhost:5180/?preview=1` to play a scripted conversation with placeholder data (no Cognigy needed)
- `?debug=1` logs every message in and out to the browser console
- Optional URL parameters: `offer`, `utm_campaign`, `utm_source` (marketing attribution), `user` (force a user id), `quote` (force a quote ref)

`localhost` counts as a secure context, so the microphone works without HTTPS. `serve.py` is `http.server` with
caching turned off; with plain `python3 -m http.server`, browsers keep stale JS and CSS after edits (hard-reload
with Cmd+Shift+R if you see an unstyled page).

## Connect it to the build flow (Forward Deployed Demo)

Both endpoints are set in `js/config.js`: the existing **Webchat** (webchat3) and **WebRTC** (voiceGateway2)
endpoints in project AISA FDE - Auto (`6abb0ff63ef6ca27fdcc759e`), both pointing at flow **Forward Deployed Demo**
(`6abb158ecd2fd542651625f3`), which the plans call Fde. These endpoints are shared, so check with the team before
changing their settings.

Because the page talks to the Webchat endpoint through the Socket.IO client, Webchat's own home screen and privacy
notice are skipped. The page carries the AI and recording disclosure instead. Whether Travelers needs an explicit
consent click is still to confirm.

## Contract between the page and the flow

The flow has to implement its side for the panel, upload and channel switch to work. Until it does, the
conversation still runs; the panel just stays empty.

### Page to flow

| When | Channel | Payload |
|---|---|---|
| Customer picks "Chat with AISA" | Chat message, text "I'd like to start an auto quote" | `{ aisa_entry: { quoteId, offerId, campaign, source, landedAt, channel: "chat" } }` |
| Customer picks "Upload my declaration page" first | Same as above, plus `intent` | `{ aisa_entry: { ..., channel: "chat", intent: "upload_dec_page" } }` |
| Paperclip or "Share declaration page" during the conversation | Active channel, text "I'd like to share my declaration page" | `{ aisa_event: { type: "upload_requested", quoteId } }` |
| Customer picks "Talk with AISA", or switches from chat | Voice, SIP INFO on answer | `{ aisa_entry_json: "<JSON string of { ..., channel: \"voice\", switchedFrom: \"chat\" or null, handoff, recent }>" }`. A string because Voice Gateway rewrites SIP INFO data keys (`quoteId` arrives as `quote_id`, `client.firstName` as `client_firstname`); string values pass through unchanged |
| Customer switches chat to voice (once the call is live) | Chat, data only | `{ aisa_event: { type: "switching_to_voice", quoteId } }` |
| Call ends, page returns to chat (only if the call was answered) | Chat, data only | `{ aisa_event: { type: "returned_from_voice", quoteId, handoff, recent } }` |
| "These are correct" / "Everything looks right" in the panel | Active channel, text, e.g. "Yes, my vehicle details are correct." | none: an ordinary customer message, so AISA records it with its tools |
| "Something's not right? Tell AISA" in the panel | Active channel, text, e.g. "I need to correct something in my driver details." | none |
| "Talk to a person" | Active channel, text "I'd like to talk to a person" | `{ aisa_action: "live_agent", quoteId }` |
| Suggested reply tapped | Active channel | the reply's `payload` as text |
| Customer browses the panel, shows or hides it, closes a card; an xApp screen loads or its upload status changes | Active channel, data only, no reply | `{ aisa_screen_json: "<JSON string of { v: 1, panelOpen, step, cards, upload }>" }` (see "On-screen awareness") |

"Active channel" means a SIP INFO when a call is live, otherwise a chat message. Text typed during a call is sent
as a SIP INFO too, so the flow should accept typed input on the voice endpoint.

Flow handling notes:

- The panel is read-only (Travelers doesn't want a form, 2026-10-01). Answers only change through the conversation,
  so corrections get the same contradiction detection (7A) as any answer. The panel's buttons send plain text.
- `recent` is the last 12 transcript turns (`{ from: "customer" | "aisa", text }`, 400 chars each), kept in memory by
  the page. The flow caps it again, labels it context only, and adds it to the agent's turn memory.
- Never default a value the customer did not give (7A). The panel only shows what the flow sends.

### Flow to page

Send an `aisa_ui` object. In chat, as the `data` of a message (a data-only Say or `api.say("", { aisa_ui })`);
data-only messages never render as empty bubbles. In voice, with a Send Metadata node. Fields are upserted by
`key`, so send only what changed.

```json
{
  "aisa_ui": {
    "status": "collecting | quote_ready | rating | advisor_requested",
    "section": "client | vehicles | drivers | losses | policy | review | rate",
    "progress": { "done": 13, "total": 24 },
    "fields": [
      { "key": "vehicle[1].year", "value": "2024", "source": "customer | extracted | prefilled | derived", "confirmed": true }
    ],
    "removeKeys": ["vehicle[1].vin"],
    "xappUrl": "https://...",
    "advisorSummary": "text",
    "notice": "text"
  }
}
```

- `section` moves the panel to that step, so the panel follows the conversation.
- Field keys use the CLAUDE.md section 6B data model and the keys in `js/questions.js` (`client.firstName`,
  `vehicle[0].year`, `driver[1].licenseStatus`, `loss[0].injuries`, `policy.priorCarrier`). Keys the panel does
  not know still appear on the Review step.
- `source: "extracted"` and `"prefilled"` show a "From your declaration page" or "From our records" tag next to
  the field, which is the visible proof of Step 3 and Step 4.
- `confirmed: false` shows "Please confirm" (visual confirmation instead of spoken readback, per the WebRTC
  adaptations).
- Quick replies and postback buttons: send them in Cognigy's default format (`_quickReplies` or `_buttons` in a
  Say node) and they render as tappable replies.

### On-screen awareness

AISA knows what the customer is looking at, so "what's this?", "is that right?" or "I sent it" make sense without asking
what they mean (pattern from Durga's hands-on demo, 2026-10-01). Switch: `screenAwareness` in `js/config.js`.

- **What is sent** (`js/screen.js`): `{ v: 1, panelOpen, step, cards, upload }`. `step` is a panel step id; `cards` any of
  `upload_screen`, `rate_page`, `advisor_summary`, `shared_screen`; `upload` is `{ status, kind, error }` with status
  `open | preparing | uploading | uploaded | failed | declined`, kind `photo | pdf`, and an error code (`expired`,
  `too_big`, `wrong_type`, `cant_open`, `timeout`, `network`, `rejected`, `unavailable`). Ids and codes only, never text.
  One JSON string, because Voice Gateway rewrites SIP INFO keys.
- **When:** only on changes the customer made (step buttons, show or hide, closing a card, the upload screen), 1.2 s
  after things settle, and once more when a session starts (call answered, back in chat). When AISA moves the panel,
  nothing is sent; the flow knows.
- **Flow:** "Code: Page events and guardrails" keeps only whitelisted values in `context.screen`, sets
  `context.screenReportOnly`, and "If: Screen report only" goes to Stop and Return: no reply, no turn counted (7A).
  On the next real turn the agent's memory gets an `ON SCREEN` line. If AISA has moved the panel since the report, the
  flow's own section is used, because the panel follows the conversation.
- **Exception:** an upload that fails during a call gets one spoken line (the customer may not be looking). In chat
  the screen shows its own error, so AISA stays quiet.
- **xApp screens** post `{ aisa: "screen", screen: "dec_upload" | "rate_page" }` when they load and the upload screen
  posts `{ aisa: "upload_status", status, kind, error }`, both to the top window (see "xApp to page messages").

### Chat to voice continuity (Step 7), without Contact Profiles

Decision 2026-10-01: Travelers' privacy rules may not allow Contact Profiles, so nothing about the quote is stored
outside the Cognigy session and the customer's browser. The page relays the state between sessions instead.

- **Ids.** Every page load is a new quote (`Q-...`). Chat uses userId `aisa-<quoteId>` and sessionId
  `chat-<quoteId>`. A call started from chat uses userId `aisa-<quoteId>-fromchat`; a voice-first call uses
  `aisa-<quoteId>`. Opaque, no PII (per the Click To Call docs). Nothing goes in localStorage.
- **`aisa_ui.handoff`.** Whenever the quote changes, the flow adds `handoff` to `aisa_ui`:
  `{ v: 1, quoteId, resumed, aisa, follow_up, asks, turnMemory }`. The page keeps only the latest, in memory
  (`state.js`), never renders it, and returns it unchanged.
- **Chat to voice.** The page starts the call and, on `answered`, sends `aisa_entry` with `switchedFrom: "chat"`,
  `handoff` and `recent` over SIP INFO. The flow's first voice turn sees `-fromchat` in the userId, says a short welcome
  back and the voice notice (no second disclosure). "Code: Page events and guardrails" (before the AI Agent) finds the
  entry wherever the SIP INFO puts it in `input.data`, loads the handoff, and AISA carries on with chat's next step.
  If nothing arrives after the customer speaks twice or 20 seconds, AISA says so and carries on by voice.
- **Voice to chat.** On hang-up the page sends `aisa_event.returned_from_voice` with the call's last `handoff`, or,
  if chat never started, starts chat with `aisa_entry.switchedFrom: "voice"` and the `handoff`.
- **Checks in the flow** (untrusted input): same quote id, at most `handoffMaxAgeMin` old, newer than the session's
  own state, under 60 KB, and on return to chat only from a call that started from this chat's state.
- **Known gap.** On voice, panel updates (and so the handoff) reach the page one turn late until the Send Metadata
  nodes after each quote update are added (BY_HAND 6). Until then the last voice answer can be missing in chat. The
  `recent` turns tell AISA what was said, but a live test showed the model doesn't reliably save a missed answer from
  them, so BY_HAND 6 is the real fix.
- `DEMO SHORTCUT`: production passes only the quote id and the flow reads the draft quote from Travelers' system of
  record (UR / Salesforce) through an HTTP Request node with a Connection. Page-relayed state is not trusted there.

### Declaration page (Step 3): xApp upload to Azure Blob, chat and voice alike

The page never touches the document. AISA opens an upload screen (an xApp) in the panel's "Shared by AISA" card:

1. **Open.** `upload_declaration_page` runs the Extension node "Azure Blob: Create upload link" (a 15-minute
   create/write link and a 30-minute read link for one new file `<quoteId>/<uuid>.jpg`, signed with the account key
   held in a Cognigy Connection), then "xApp: Init upload session" and "xApp: Show HTML (upload screen)"
   (`cognigy-nodes/xapps/dec_upload.html`), and sends the screen's URL to the panel.
2. **Upload.** The customer takes a photo or picks a PDF. The screen turns it into one JPEG (PDF: page 1 via pdf.js),
   PUTs it straight to the container with the upload link, and submits only `{ type: "dec_page_uploaded" }`.
3. **Read.** "Code: Page events and guardrails" marks the upload ready, and "If: Declaration page uploaded" (before the
   AI Agent) runs "Read declaration page (GPT-4.1)" with the read link, then the usual map, merge, validate and panel
   nodes, then "Azure Blob: Delete file". AISA's turn starts from the result: values tagged "Dec page", to confirm.
4. **Fallbacks.** No connection yet, or a phone caller: AISA says the upload isn't available and carries on. An
   expired link or an unreadable page: AISA says so and offers to try again or continue.

Why the Extension reads it and not the AI Agent: Process Images only sees images attached to the incoming message;
an image a node adds later is ignored (tested 10/1). Setup (connections, CORS, lifecycle rule): BY_HAND 0b.
`DEMO SHORTCUT`: page 1 of a PDF only; production may read every page, or use a document model.

### The quote panel is read-only

- Every value comes from the flow (`aisa_ui`), with a short source tag: "You", "Dec page", "Records", "Same as you"
  (the full wording is the tooltip and the screen reader label). Values that still need checking add "· confirm".
- When answers arrive or change, the panel jumps to the step they landed on (the first one, for a bulk update such as
  the declaration page), scrolls to them, and highlights them with an "Updated" mark for 8 seconds.
- "These are correct" appears on a step with values to confirm; "Everything looks right" on Review once the quote is
  ready; "Something's not right? Tell AISA" on any step with values. Each sends a customer message; the page never
  writes quote data. "Previous step" and "Next step" only change what the panel shows.

### Cards in the quote panel

- **Shared by AISA** shows an xApp screen (today the simulated rate page) while `aisa_ui.xappUrl` is set. "Loading..."
  until the frame loads, an "Open it in a new tab" fallback, and a close button.
- **Shared with your licensed advisor** shows `aisa_ui.advisorSummary` at the top of the panel on every step, and stays
  after a call ends. It has a close button.
- A dismissed card stays hidden until the flow sends something new (another screen, or a changed summary). The Rate
  step offers "Show ... again".
- **xApp to page messages.** The xApp shell renders a screen in a nested frame, so a screen inside the landing page is
  screen > shell > page. Screens post to the top window; the page (`app.js`) accepts a message only from a frame inside
  its own panel frame, and only known values. The rate page's advisor button posts `{ aisa: "advisor_requested" }`,
  routed like "Talk to a person" (this listener had gone missing from `app.js` and was restored on 2026-10-01). Screens
  also report what they show (see "On-screen awareness"). Opened on its own (one frame
  less), the screen submits to the flow instead, which the router node handles.

## Known limits and demo shortcuts

- `DEMO SHORTCUT`: the two client libraries load from jsDelivr (pinned versions). Production self-hosts them with
  Subresource Integrity.
- `PLACEHOLDER`: step order and the 7-step split follow the one wireframe screen we have ("Step 3/7: Add
  Drivers"). Confirm against Jill's full set.
- `PLACEHOLDER`: some panel fields are free text where the question set points at reference data it doesn't
  include (registered to, owned or leased, usage, loss description and amount, bodily injury limit).
- State-specific questions are not shown in the panel; the flow owns state logic.
- Three wireframe fields are not in the web question set: age first licensed, SR-22, and "which vehicle do you
  drive most often" (the set has primary driver per vehicle instead). Marked `src: "wireframe"` in `questions.js`.
- Occupation is required in the web set, but the Homeowners agent was flagged for asking it. Marked `REVIEW`.
- No TURN server is configured (`iceServers` in config). Needed before venue or recording-day testing on
  restrictive networks.
- Offer copy and all preview data are placeholders.
