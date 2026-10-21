import { CONFIG } from "./config.js";
import { createStore } from "./state.js";
import { createChat } from "./chat.js";
import { createVoice } from "./voice.js";
import { createPanel } from "./panel.js";
import { createTranscript } from "./transcript.js";
import { createScreenReporter } from "./screen.js";
import { PREVIEW_SCRIPT } from "./preview.js";
import { randomId, formatClock, debug } from "./util.js";

const params = new URLSearchParams(location.search);
const isPreview = params.get("preview") === "1";
const isDebug = params.get("debug") === "1";

// Contact Profile keyed on quoteId (via userId = "aisa-<quoteId>") is the primary cross-session store. Both chat and
// voice share the same userId so they share the same profile. Nothing is stored on the device.
// Chat and voice keep separate session ids: reusing user+session across endpoints causes collisions.
const quoteId = params.get("quote") || randomId("Q");
const identity = { userId: `aisa-${quoteId}`, quoteId, chatSessionId: `chat-${quoteId}` };

const entry = {
  quoteId,
  offerId: params.get("offer") || CONFIG.defaultOffer.offerId,
  campaign: params.get("utm_campaign") || CONFIG.defaultOffer.campaign,
  source: params.get("utm_source") || CONFIG.defaultOffer.source,
  landedAt: new Date().toISOString(),
  // This page shows aisa_ui.choices as buttons, so the flow can stop naming every option in AISA's text (and on a call,
  // point to the screen instead of reading a list). An older page leaves this out and keeps the spoken or typed options.
  // multiChoices: tick boxes for "select all that apply"; rowChoices: a row of buttons per part of a grouped question (2026-10-11)
  // disclosureShown: this page shows the AI-assistant and recording note under the input, so the welcome can leave it
  // out (2026-10-14, Sascha's review). A UI that doesn't show it leaves this out and the welcome keeps the disclosure.
  // uploadNoteShown: this page always shows "Add a document any time" above the input, so the chat welcome leaves out
  // its upload line (2026-10-14, Odiche). The document offer after the address is unchanged.
  ui: { choices: true, multiChoices: true, rowChoices: true, disclosureShown: true, uploadNoteShown: true },
};

const $ = (sel) => document.querySelector(sel);
const store = createStore();
const toast = $("[data-toast]");

function say(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(say.t);
  say.t = setTimeout(() => (toast.hidden = true), 6000);
}

// Technical status lines (a call starting or ending) only with ?debug=1 (2026-10-14, Sascha: the customer simply
// switches between typing and talking; these lines were over-confirmation). Failures still reach the customer, as a toast.
function debugNote(text) {
  debug("note", text);
  if (isDebug) transcript.note(text);
}

function setChip(name, status) {
  const chip = $(`[data-chip="${name}"]`);
  if (!chip) return;
  const labels = { off: "not configured", connecting: "connecting", ready: "ready", live: "live", error: "error" };
  chip.dataset.state = status;
  chip.querySelector("b").textContent = labels[status] || status;
}

const transcript = createTranscript($("[data-conversation]"), {
  onChoice: (c) => sendText(c.title, c.payload),
});

// ---- Uploads open only after AISA's first message (2026-10-16, Odiche): the customer meets AISA (Once > On First Time,
// the welcome) before a document can be shared. Until then the paperclip is disabled, the upload note is hidden and a
// dropped file is ignored. Any AISA message on either channel opens them, and a resumed session gets its welcome too.
let aisaHasSpoken = false;
function allowUploads() {
  if (aisaHasSpoken) return;
  aisaHasSpoken = true;
  document.body.classList.add("uploads-open");
  const btn = $("[data-attach]");
  if (btn) btn.disabled = false;
  const note = $("[data-upload-note]");
  if (note) note.hidden = false;
}
function fromAisa(m) {
  if (m && m.from === "bot") allowUploads();
  transcript.add(m);
}

const chat = createChat({
  config: CONFIG,
  identity,
  onMessage: fromAisa,
  onUi: (ui) => {
    if (ui && ui.ack === true) transcript.expectAck();
    store.applyUi(ui);
  },
  onStatus: (s) => setChip("chat", s),
  onTyping: (on) => transcript.typing(on),
});

// ---- Session timer (demo only, 2026-10-12): in the demo bar, from the first message until the handover to an advisor,
// across chat and calls, so a full quote can be measured. Shows the customer's turns (anything they typed, said or
// tapped), time on calls, and when the quote was ready. Stops at the handover; a page reload starts it again.
const session = { started: 0, stopped: 0, callMs: 0, callFrom: 0, readyAt: 0, timer: null };
const sinceStart = (t) => formatClock(Math.floor(((t || Date.now()) - session.started) / 1000));
function renderSessionTimer() {
  if (!session.started) return;
  const now = session.stopped || Date.now();
  $("[data-session-clock]").textContent = sinceStart(now);
  const turns = document.querySelectorAll("[data-messages] .msg-user").length;
  const callMs = session.callMs + (session.callFrom ? now - session.callFrom : 0);
  const bits = [`${turns} customer turn${turns === 1 ? "" : "s"}`];
  if (callMs >= 1000) bits.push(`${formatClock(Math.floor(callMs / 1000))} on a call`);
  if (session.readyAt) bits.push(`quote ready at ${sinceStart(session.readyAt)}`);
  if (session.stopped) bits.push(`handover at ${sinceStart(session.stopped)}`);
  $("[data-session-detail]").textContent = "· " + bits.join(" · ");
}
function startSessionTimer() {
  if (session.started) return;
  session.started = Date.now();
  $("[data-session-timer]").hidden = false;
  renderSessionTimer();
  session.timer = setInterval(renderSessionTimer, 1000);
}
function followSessionTimer(state) {
  if (!session.started || session.stopped) return;
  if (!session.readyAt && (state.status === "quote_ready" || state.status === "rating")) session.readyAt = Date.now();
  if (state.status === "advisor_requested") {
    if (session.callFrom) { session.callMs += Date.now() - session.callFrom; session.callFrom = 0; }
    session.stopped = Date.now();
    clearInterval(session.timer);
    renderSessionTimer();
    console.info(`[session] handover at ${sinceStart(session.stopped)}: ${$("[data-session-detail]").textContent.replace(/^· /, "")}`);
  }
}

// ---- Call clock (wireframe: "On a call · 00:38")
let clockTimer = null;
function startClock() {
  if (session.started && !session.stopped && !session.callFrom) session.callFrom = Date.now();
  const started = Date.now();
  const label = $("[data-call-clock]");
  clearInterval(clockTimer);
  label.textContent = "00:00";
  clockTimer = setInterval(() => (label.textContent = formatClock(Math.floor((Date.now() - started) / 1000))), 1000);
}
function stopClock() {
  clearInterval(clockTimer);
  if (session.callFrom) { session.callMs += Date.now() - session.callFrom; session.callFrom = 0; }
}

// ---- On-screen awareness: what the customer is looking at, sent to whichever channel is live (see screen.js).
const screen = createScreenReporter({
  enabled: CONFIG.screenAwareness !== false && !isPreview,
  send: async (json) => {
    const data = { aisa_screen_json: json };
    debug("screen out", json);
    if (voice.ready) return voice.send("", data);
    if (voice.inCall) return false; // the call's entry goes first
    if (!chat.started) return false;
    await chat.send("", data, { echo: false, typing: false });
    return true;
  },
});
// A new session (call answered, back in chat) starts with no idea of the screen: tell it straight away.
function resendScreen() {
  screen.reset();
  screen.report({});
}

const voice = createVoice({
  config: CONFIG,
  identity,
  onReady: resendScreen,
  onMessage: fromAisa,
  onUi: (ui) => { if (ui && ui.ack === true) transcript.expectAck(); store.applyUi(ui); },
  onStatus: (s) => {
    setChip("voice", s);
    document.body.classList.toggle("voice-connecting", s === "connecting");
    $("[data-call-label]").textContent = s === "connecting" ? "Connecting…" : "Listening";
    if (s === "live") {
      callWasLive = true;
      startClock();
      // Tell chat only once the call is really up, so a failed call never leaves AISA replying to a switch.
      if (pendingSwitchFromChat && chat.started) chat.send("", { aisa_event: { type: "switching_to_voice", quoteId } }, { echo: false }).catch(() => {});
      pendingSwitchFromChat = false;
    }
    if (s !== "live" && s !== "connecting") {
      setMuteButton(false);
    }
  },
  // A browser call ending never ends the journey: fall back to chat with everything retained.
  onEnded: () => {
    stopClock();
    if (store.get().channel !== "voice") return;
    store.set({ channel: "chat" });
    document.body.classList.remove("voice-connecting");
    // A call that never connected (microphone blocked, network) is not a return from voice: nothing changed on the
    // call, so don't tell chat (AISA would repeat itself). Say so plainly and stay in chat.
    if (!callWasLive) {
      say("The call couldn't connect. Everything is saved, so you can keep going here.");
      if (!chat.started) startChat();
      return;
    }
    callWasLive = false;
    debugNote("Call ended. You're back in chat, and everything you told AISA is kept.");
    // Step 7: the call's state and its last turns are in the Contact Profile; the flow loads them. This is only the
    // signal that the customer is back, so AISA speaks first.
    const note = { aisa_event: { type: "returned_from_voice", quoteId } };
    (chat.started ? chat.send("", note, { echo: false }) : chat.start({ ...entry, switchedFrom: "voice" })).then(resendScreen).catch((err) => say(err.message));
  },
});

// ---- Channel actions
function enterConversation() {
  document.body.classList.add("in-conversation");
  startSessionTimer();
}

async function startChat(intent) {
  enterConversation();
  store.set({ channel: "chat" });
  if (isPreview) return;
  try {
    await chat.start(intent ? { ...entry, intent } : entry);
  } catch (err) {
    debug("chat failed", err);
    say("AISA couldn't connect. Please try again in a moment.");
  }
}

let pendingSwitchFromChat = false;
let callWasLive = false; // set when the call is answered; a call that fails before that never "returns" to chat
async function startVoice(fromChat) {
  enterConversation();
  if (isPreview) {
    store.set({ channel: "voice" });
    startClock();
    return;
  }
  try {
    pendingSwitchFromChat = Boolean(fromChat);
    store.set({ channel: "voice" });
    debugNote(fromChat ? "Switching to voice." : "Starting a voice conversation in the browser.");
    // Tell chat a call is starting, before it connects (2026-10-14): if nothing has been saved yet, chat saves the open
    // question for the call to pick up, so the call carries on instead of welcoming the customer again. Silent on chat.
    if (fromChat && chat.started) {
      await chat.send("", { aisa_event: { type: "voice_starting", quoteId } }, { echo: false, typing: false }).catch(() => {});
      await new Promise((r) => setTimeout(r, 800)); // let the flow save it before the call's first turn reads it
    }
    // Step 7: the chat's state and last turns are in the Contact Profile; the entry only says where the call came from.
    await voice.start({ ...entry, switchedFrom: fromChat ? "chat" : null });
  } catch (err) {
    stopClock();
    pendingSwitchFromChat = false;
    document.body.classList.remove("voice-connecting");
    store.set({ channel: "chat" });
    debug("voice failed", err);
    // Plain words for the customer; the SDK detail goes to the debug log.
    const reason = /microphone|permission|NotAllowed/i.test(err.message) ? "the microphone isn't available" : "the call couldn't connect";
    say(`Talking isn't available right now (${reason}). Everything is saved, so you can keep typing.`);
    if (!chat.started) startChat();
  }
}

async function sendText(text, payload) {
  const message = (payload ?? text ?? "").trim();
  if (!message) return;
  if (isPreview) {
    transcript.add({ from: "user", text, via: "chat" });
    return;
  }
  try {
    if (voice.inCall) {
      await voice.send(message);
    } else {
      if (store.get().channel === "idle") store.set({ channel: "chat" });
      enterConversation();
      await chat.send(message, undefined);
    }
  } catch (err) {
    say(err.message);
  }
}

// A page button the flow acts on in code (2026-10-08): only data goes to the flow, no customer sentence for the model
// to interpret. The page shows what was pressed as the customer's bubble; the flow names the button in its transcript.
async function sendEvent(label, data) {
  enterConversation();
  transcript.add({ from: "user", text: label, via: voice.inCall ? "typed" : "chat" });
  if (isPreview) return;
  try {
    if (voice.inCall) await voice.send("", data);
    else {
      if (store.get().channel === "idle") store.set({ channel: "chat" });
      await chat.send("", data, { echo: false });
    }
  } catch (err) {
    say(err.message);
  }
}

function talkToPerson() {
  return sendEvent(CONFIG.liveAgentText, { aisa_action: "live_agent", quoteId });
}

// ---- Declaration page (Step 3): AISA opens an upload screen (xApp) in the panel, on chat and voice alike. The screen
// uploads the file straight to the bucket; the page never handles the document. These buttons only ask for the screen.
async function requestUpload() {
  if (!aisaHasSpoken || attachBusy()) return; // no upload before AISA's welcome (see allowUploads)
  setAttachPhase("opening", 12000);
  enterConversation();
  return sendEvent(CONFIG.uploadText, { aisa_event: { type: "upload_requested", quoteId } });
}

// ---- Upload button (2026-10-11): the one labelled way to share a document, in chat and during a call. It shows what is
// happening (opening the screen, uploading, reading), how many documents were read, and draws the eye once when AISA
// offers the upload (aisa_ui.documents.offer). The phases are page-side only and always time out, so the button can
// never stay stuck if an update is lost.
const attachBtn = $("[data-attach]");
let attachPhase = null; // "opening" | "uploading" | "reading" | null
let attachTimer = null;
const attachBusy = () => attachPhase !== null;
function setAttachPhase(phase, ms) {
  attachPhase = phase;
  clearTimeout(attachTimer);
  if (phase && ms) attachTimer = setTimeout(() => setAttachPhase(null), ms);
  renderAttach();
}
const ATTACH_LABEL = { opening: "Opening upload…", uploading: "Uploading…", reading: "Reading document…" };
function renderAttach() {
  const read = (store.get().documents || {}).read || 0;
  const busy = attachBusy();
  const label = ATTACH_LABEL[attachPhase] || (read ? "Add another document" : "Upload document");
  attachBtn.querySelector("[data-attach-label]").textContent = label;
  attachBtn.setAttribute("aria-busy", String(busy));
  attachBtn.dataset.state = busy ? "busy" : read ? "done" : "idle";
  attachBtn.setAttribute("aria-label", busy ? label : read ? `Add another document. ${read} document${read === 1 ? "" : "s"} read so far.` : "Upload a document, photo or PDF");
  const count = attachBtn.querySelector("[data-attach-count]");
  count.hidden = !read || busy;
  count.textContent = String(read); // " read" is added by CSS, dropped on phones
  // The hint above the bar says the same thing in words; after a read it invites another document.
  const noteLong = $("[data-upload-note-long]"), noteShort = $("[data-upload-note-short]");
  if (noteLong && noteShort) {
    noteLong.textContent = read ? `${read} document${read === 1 ? "" : "s"} read. Add another any time with the paperclip.` : "Add a declaration page, insurance card or license any time with the paperclip. AISA only asks what's missing.";
    noteShort.textContent = read ? `${read} document${read === 1 ? "" : "s"} read. Add another with the paperclip.` : "Add any auto document with the paperclip.";
  }
}
function pulseAttach() {
  if (attachBusy()) return;
  attachBtn.classList.remove("attach-pulse");
  void attachBtn.offsetWidth; // restart the animation if it is already running
  attachBtn.classList.add("attach-pulse");
  setTimeout(() => attachBtn.classList.remove("attach-pulse"), 4000);
}
let lastDocs = null;
let lastXappUrl = null;
function followAttach(state) {
  if (state.xappUrl !== lastXappUrl) {
    if (state.xappUrl && attachPhase === "opening") setAttachPhase(null); // the screen is up
    if (!state.xappUrl && attachPhase) setAttachPhase(null); // the screen closed (read, unreadable, or dismissed)
    lastXappUrl = state.xappUrl;
  }
  const docs = state.documents;
  if (docs !== lastDocs) {
    const before = (lastDocs && lastDocs.read) || 0;
    if (docs && (docs.read > before || docs.status === "unreadable") && attachPhase === "reading") setAttachPhase(null);
    if (docs && docs.offer && !state.xappUrl) pulseAttach(); // never while the upload screen is already showing
    lastDocs = docs;
  }
  renderAttach();
}

// ---- Panel
// The review panel. Nothing on the page writes quote data: its buttons send events the flow applies in code (a step's
// "These are correct", an edited answer, a removed vehicle, driver or incident), or a sentence for AISA where the agent
// has to respond to it. The flow checks and saves the change and sends the panel the result.
// The topic word for each step ("my vehicle details") comes from the flow's catalog (rules.panel.steps[].topic).
const topic = (step) => step.topic || "quote";

// ?preview=1 has no flow to answer an edit, so it answers like the flow would, to show the round trip on the page.
function previewAnswer(ui) {
  if (isPreview) setTimeout(() => store.applyUi(ui), 600);
}
const panel = createPanel($("[data-panel]"), {
  config: CONFIG,
  // "Everything looks right" stays a sentence: confirming the whole quote is the agent's confirm_quote step. A step's
  // "These are correct" is an event the flow applies in code (turn_router.js confirm_section).
  onConfirm: ({ step, all }) => all
    ? sendText("Yes, everything in my quote looks right.")
    : sendEvent(`Yes, my ${topic(step)} details are correct.`, { aisa_event: { type: "confirm_section", section: step.id, quoteId } }),
  onCorrect: ({ step }) => sendText(`I need to correct something in my ${topic(step)} details.`),
  // The pencil and the bin (2026-10-20). The bubble says what the customer did, in words; the flow gets only data
  // (router_events.js panel_edit / panel_remove), so nothing they type there reaches the model as an instruction.
  onEdit: ({ field, value, shown, where }) => {
    sendEvent(`Change ${where ? `the ${field.label} for the ${where}` : field.label} to ${shown}.`, { aisa_event: { type: "panel_edit", path: field.path, value, quoteId } });
    previewAnswer({ fields: [{ ...field, value: shown, source: "customer", confirmed: true }] });
  },
  onRemove: ({ path, name, keys }) => {
    sendEvent(`Remove ${name}.`, { aisa_event: { type: "panel_remove", path, quoteId } });
    previewAnswer({ removeKeys: keys });
  },
  onPerson: talkToPerson,
  onView: ({ step, xapp, advisor }, byCustomer) => {
    const cards = [];
    if (xapp) cards.push(SCREEN_CARD[xappKind] || "shared_screen");
    if (advisor) cards.push("advisor_summary");
    // The upload status only means something while the upload screen is showing.
    const patch = { step, cards, ...(xapp && xappKind === "dec_upload" ? {} : { upload: null }) };
    if (byCustomer) screen.report(patch);
    else screen.track(patch);
  },
});

// ---- Quote drawer on phones (TDS Drawer pattern, Figma 8.8.0 "Drawer for a Chat"). Under 900 px the panel is a drawer
// from the right, opened from the "Your quote" bar above the composer. It opens on its own only for what the customer
// has to see: a screen AISA shares (upload, rate page), Review and the rate step, and the advisor summary. Other updates
// only mark the bar "Updated". Escape, the scrim and the close button close it; focus stays inside while it is open.
const phone = window.matchMedia("(max-width: 900px)");
const panelEl = $("[data-panel]");
const peekBtn = $("[data-action='open-quote']");
const scrim = $(".drawer-scrim");
let drawerOpen = false;
let drawerReturn = null;
screen.track({ panelOpen: !phone.matches });

function setDrawer(open, { byCustomer = true } = {}) {
  if (open === drawerOpen) return;
  drawerOpen = open;
  document.body.classList.toggle("quote-open", open);
  scrim.hidden = !open;
  peekBtn.setAttribute("aria-expanded", String(open));
  if (open) {
    panelEl.setAttribute("role", "dialog");
    panelEl.setAttribute("aria-modal", "true");
    $("[data-peek-new]").hidden = true;
    drawerReturn = document.activeElement;
    panelEl.querySelector(".panel-head .icon-btn").focus({ preventScroll: true });
  } else {
    panelEl.removeAttribute("role");
    panelEl.removeAttribute("aria-modal");
    if (drawerReturn && panelEl.contains(document.activeElement)) drawerReturn.focus({ preventScroll: true });
    drawerReturn = null;
  }
  if (byCustomer) screen.report({ panelOpen: open });
  else screen.track({ panelOpen: open });
}
peekBtn.addEventListener("click", () => setDrawer(true));
scrim.addEventListener("click", () => setDrawer(false));
document.addEventListener("keydown", (e) => {
  if (!drawerOpen) return;
  if (e.key === "Escape") return setDrawer(false);
  if (e.key !== "Tab") return;
  const items = [...panelEl.querySelectorAll("button, a[href], iframe, [tabindex]:not([tabindex='-1'])")]
    .filter((x) => !x.disabled && x.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
// Rotating or resizing past the breakpoint: the desktop panel takes over, so leave no drawer state behind.
phone.addEventListener("change", () => {
  if (!phone.matches) setDrawer(false, { byCustomer: false });
  screen.track({ panelOpen: phone.matches ? drawerOpen : !document.body.classList.contains("panel-hidden") });
});

let drawerSeen = null;
function followDrawer(state) {
  // The bar mirrors the panel's own step label and "filled for you" chip.
  $("[data-peek-step]").textContent = $("[data-step-label]").textContent;
  const eff = $("[data-eff]");
  const peekEff = $("[data-peek-eff]");
  peekEff.hidden = eff.hidden;
  peekEff.textContent = eff.hidden ? "" : eff.textContent.split(" · ")[0]; // the count only; no room for "time saved"
  const seen = drawerSeen || {};
  // applyUi copies the field map on every update, so compare what the customer would see, not the map.
  const fieldsSig = [...state.fields.values()].map((f) => `${f.key}=${f.value}|${f.source}|${f.confirmed}`).join("\n");
  drawerSeen = { xappUrl: state.xappUrl, advisorSummary: state.advisorSummary, focusSeq: state.focus && state.focus.seq, fieldsSig };
  if (!phone.matches || !document.body.classList.contains("in-conversation")) return;
  const mustSee = (state.xappUrl && state.xappUrl !== seen.xappUrl)
    || (state.advisorSummary && state.advisorSummary !== seen.advisorSummary)
    || (state.focus && state.focus.seq !== seen.focusSeq && ["review", "rate"].includes(state.focus.section));
  if (mustSee) return setDrawer(true, { byCustomer: false });
  const changed = (state.focus && state.focus.seq !== seen.focusSeq) || (seen.fieldsSig !== undefined && fieldsSig !== seen.fieldsSig);
  if (changed && !drawerOpen) $("[data-peek-new]").hidden = false;
}

// ---- Messages from xApp screens in the panel. The xApp shell renders a screen in a nested frame (screen > shell >
// page), so accept a message only from a frame inside our own panel frame; the screen's origin can be "null".
// Payloads are checked against fixed lists; nothing from them is shown or sent as text.
const SCREEN_CARD = { dec_upload: "upload_screen", rate_page: "rate_page" };
const UPLOAD_STATUSES = ["open", "preparing", "uploading", "uploaded", "failed", "declined"];
const UPLOAD_ERRORS = ["expired", "too_big", "wrong_type", "cant_open", "timeout", "network", "rejected", "unavailable"];
let xappKind = null; // which screen the panel frame is showing, as the screen itself announced
let screenWindow = null; // that screen's own frame, for handing it a dropped file
let xappKindUrl = null;
const xappFrame = $("[data-xapp]");
function fromPanelFrame(source) {
  try {
    for (let w = source, i = 0; w && i < 5; w = w.parent, i++) {
      if (w === xappFrame.contentWindow) return true;
      if (w === w.parent) break;
    }
  } catch {
    /* cross-origin parent walk refused: treat as not ours */
  }
  return false;
}
window.addEventListener("message", (event) => {
  const m = event.data;
  if (!m || typeof m !== "object" || typeof m.aisa !== "string" || !fromPanelFrame(event.source)) return;
  debug("xapp message", m);
  if (m.aisa === "advisor_requested") return talkToPerson();
  if (m.aisa === "screen" && SCREEN_CARD[m.screen]) {
    xappKind = m.screen;
    xappKindUrl = store.get().xappUrl;
    screenWindow = event.source;
    if (m.screen === "dec_upload") offerDroppedFile(event.source);
    const v = screen.view;
    screen.report({ cards: [SCREEN_CARD[m.screen], ...v.cards.filter((c) => c !== "shared_screen" && c !== SCREEN_CARD[m.screen])], ...(m.screen === "dec_upload" ? { upload: { status: "open", kind: null, error: null } } : { upload: null }) });
    return;
  }
  if (m.aisa === "upload_status" && xappKind === "dec_upload" && UPLOAD_STATUSES.includes(m.status)) {
    const upload = { status: m.status, kind: m.kind === "pdf" || m.kind === "photo" ? m.kind : null, error: UPLOAD_ERRORS.includes(m.error) ? m.error : null };
    // On a call the customer may not be watching the screen, so a failure goes out at once and AISA says so.
    screen.report({ upload }, { urgent: m.status === "failed" && voice.inCall });
    if (m.status === "preparing" || m.status === "uploading") setAttachPhase("uploading", 90000);
    else if (m.status === "uploaded") setAttachPhase("reading", 60000);
    else if (m.status === "failed" || m.status === "declined") setAttachPhase(null);
    // "I'd rather keep talking": the screen is done, so close its card (and the drawer on a phone) instead of leaving the
    // xApp shell's empty page showing.
    // The screen submits its result right after this status, so close a moment later, never mid-submit.
    if (m.status === "declined") {
      panel.coverXapp("Okay, let's keep talking.");
      setTimeout(() => {
        panel.closeXapp();
        if (phone.matches) setDrawer(false, { byCustomer: false });
      }, 2500);
    }
    // The screen submits right after this, and the xApp shell then shows an empty page: show progress instead. The
    // flow closes the card once the page is read (or found unreadable), which clears this.
    if (m.status === "uploaded") {
      panel.showXappStatus({
        text: "Got it. AISA is reading your document…",
        slowText: "This is taking longer than usual. You can keep going with AISA in the meantime.",
      });
    }
  }
});

// ---- Drop a document on the conversation (2026-10-14, Sascha: "drag documents in at any time"). The page never uploads
// the file itself: the drop opens the upload screen (the same request as the upload button), and the file is offered
// to that screen as soon as it announces itself ({ aisa: "file", file } to the screen's frame). A screen that doesn't
// take files that way still opens, and the customer is told to drop or choose the file there.
const conversationEl = $("[data-conversation]");
const DROP_TYPES = /^(image\/(jpeg|png|heic|heif|webp)|application\/pdf)$/;
let pendingDrop = null; // { file, at }
let dropHint = null;
let dragDepth = 0;
const draggingFiles = (e) => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes("Files");
function offerDroppedFile(target) {
  if (!pendingDrop || Date.now() - pendingDrop.at > 60000) return (pendingDrop = null);
  try { target.postMessage({ aisa: "file", file: pendingDrop.file }, "*"); } catch (err) { debug("drop handoff failed", err); }
  pendingDrop = null;
  // If the screen doesn't start uploading, it doesn't take dropped files yet: say what to do instead.
  clearTimeout(dropHint);
  dropHint = setTimeout(() => {
    if (attachPhase !== "uploading" && attachPhase !== "reading") say("Drop your file on the upload screen, or choose it there.");
  }, 3000);
}
conversationEl.addEventListener("dragenter", (e) => {
  if (!draggingFiles(e) || !aisaHasSpoken) return;
  e.preventDefault();
  dragDepth += 1;
  conversationEl.classList.add("drop-target");
});
conversationEl.addEventListener("dragover", (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});
conversationEl.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) conversationEl.classList.remove("drop-target");
});
conversationEl.addEventListener("drop", (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  conversationEl.classList.remove("drop-target");
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file || !aisaHasSpoken) return;
  if (!DROP_TYPES.test(file.type)) return say("That file can't be read. Share a photo (JPEG or PNG) or a PDF.");
  pendingDrop = { file, at: Date.now() };
  if (screenWindow && xappKind === "dec_upload" && store.get().xappUrl) return offerDroppedFile(screenWindow);
  requestUpload();
});
// A file dropped anywhere else must not make the browser leave the page to open it.
window.addEventListener("dragover", (e) => { if (draggingFiles(e)) e.preventDefault(); });
window.addEventListener("drop", (e) => { if (draggingFiles(e)) e.preventDefault(); });

// ---- Wiring
const on = (action, fn) => document.querySelectorAll(`[data-action="${action}"]`).forEach((b) => b.addEventListener("click", fn));
on("start-chat", () => startChat());
on("start-voice", () => startVoice(false));
on("upload", requestUpload);
on("attach", requestUpload);
on("switch-voice", () => startVoice(true));
on("hang-up", () => (isPreview ? voice_previewEnd() : voice.end().catch((err) => say(err.message))));
function setMuteButton(muted) {
  const btn = $('[data-action="mute"]');
  btn.setAttribute("aria-pressed", String(muted));
  btn.setAttribute("aria-label", muted ? "Unmute" : "Mute");
  btn.title = muted ? "Unmute" : "Mute";
}
on("mute", async () => setMuteButton(await voice.toggleMute()));
on("person", talkToPerson);
on("toggle-panel", () => {
  if (phone.matches) return setDrawer(false); // on phones the panel's close button closes the drawer
  const hidden = document.body.classList.toggle("panel-hidden");
  screen.report({ panelOpen: !hidden });
  const tab = $(".panel-tab");
  tab.setAttribute("aria-expanded", String(!hidden));
  // Focus follows the control that can undo it: the show tab while collapsed, the collapse chevron while open.
  (hidden ? tab : panelEl.querySelector(".panel-collapse")).focus({ preventScroll: true });
});

const input = $("[data-composer-input]");
$("[data-composer-form]").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = "";
  sendText(text);
});
// The bar starts one line high and grows with the message, up to about six lines (then it scrolls).
function fitInput() {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
}
input.addEventListener("input", fitInput);
$("[data-composer-form]").addEventListener("submit", () => requestAnimationFrame(fitInput));
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("[data-composer-form]").requestSubmit();
  }
});

let lastNotice = null;
let lastChoices = null;
store.subscribe((state) => {
  followSessionTimer(state);
  // A new screen in the panel: forget which one was showing until it announces itself.
  if (state.xappUrl !== xappKindUrl) {
    xappKind = null;
    xappKindUrl = state.xappUrl;
  }
  panel.render(state);
  followAttach(state);
  followDrawer(state);
  document.body.dataset.channel = state.channel;
  // On a call the bar already shows the call, so the box only invites typing (a long hint wraps on a phone).
  input.placeholder = state.channel === "voice" ? "Or type here" : "Type or talk to AISA";
  $("[data-preview]").hidden = !state.preview;
  if (state.notice && state.notice !== lastNotice) transcript.note(state.notice);
  // The question's options as buttons under AISA's latest message (chat and during a call). A tap is data only: the flow
  // saves it in code and accepts only an option it just offered (turn_router.js "choice").
  if (state.choices !== lastChoices) {
    lastChoices = state.choices;
    const set = state.choices;
    transcript.offer(set, (value) => set.rows
      // { rowPath: option } for the rows answered; the flow saves those and asks for the rest (turn_router.js "choice").
      ? sendEvent(set.rows.filter((r) => value[r.path]).map((r) => `${r.label ? r.label.replace(/\?$/, "") + ": " : ""}${value[r.path]}`).join(". "),
        { aisa_event: { type: "choice", path: set.path, rows: value, quoteId } })
      : set.multi
      // Ticked labels (empty for "None of these"); the flow saves every listed feature (turn_router.js "choice").
      ? sendEvent(value.length ? value.join(", ") : set.none, { aisa_event: { type: "choice", path: set.path, values: value, quoteId } })
      : sendEvent(value, { aisa_event: { type: "choice", path: set.path, value, quoteId } }));
  }
  lastNotice = state.notice;
});

setChip("chat", CONFIG.webchatConfigUrl ? "ready" : "off");
setChip("voice", CONFIG.voiceEndpointUrl ? "ready" : "off");
$("[data-quote-id]").textContent = quoteId;
$("[data-demo-bar]").hidden = !isDebug; // the demo notice and session timer are for us, not the customer or the recording

// ---- Preview: plays a scripted conversation (placeholder data) so the layout can be reviewed without Cognigy.
function voice_previewEnd() {
  stopClock();
  store.set({ channel: "chat" });
  debugNote("Call ended. You're back in chat, and everything you told AISA is kept.");
}

if (isPreview) {
  store.set({ preview: true });
  enterConversation();
  store.set({ channel: "chat" });
  let t = 400;
  for (const step of PREVIEW_SCRIPT) {
    t += step.wait ?? 1100;
    setTimeout(() => {
      if (step.channel) {
        store.set({ channel: step.channel });
        if (step.channel === "voice") startClock();
        else stopClock();
      }
      if (step.note) (step.channel ? debugNote : transcript.note)(step.note); // a channel switch note is technical, like the live ones
      if (step.bot) fromAisa({ from: "bot", text: step.bot, choices: step.choices || [], via: step.via || "chat" });
      if (step.user) transcript.add({ from: "user", text: step.user, via: step.via || "chat" });
      if (step.ui) store.applyUi(step.ui);
    }, t);
  }
}
