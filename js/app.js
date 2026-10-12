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
  ui: { choices: true, multiChoices: true, rowChoices: true },
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

const chat = createChat({
  config: CONFIG,
  identity,
  onMessage: (m) => transcript.add(m),
  onUi: (ui) => {
    if (ui && ui.ack === true) transcript.expectAck();
    store.applyUi(ui);
  },
  onStatus: (s) => setChip("chat", s),
  onTyping: (on) => transcript.typing(on),
});

// ---- Call clock (wireframe: "On a call · 00:38")
let clockTimer = null;
function startClock() {
  const started = Date.now();
  const label = $("[data-call-clock]");
  clearInterval(clockTimer);
  label.textContent = "00:00";
  clockTimer = setInterval(() => (label.textContent = formatClock(Math.floor((Date.now() - started) / 1000))), 1000);
}
function stopClock() {
  clearInterval(clockTimer);
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
  onMessage: (m) => transcript.add(m),
  onUi: (ui) => { if (ui && ui.ack === true) transcript.expectAck(); store.applyUi(ui); },
  onStatus: (s) => {
    setChip("voice", s);
    document.body.classList.toggle("voice-connecting", s === "connecting");
    $("[data-call-label]").textContent = s === "connecting" ? "Calling AISA…" : "On a call";
    if (s === "live") {
      callWasLive = true;
      startClock();
      // Tell chat only once the call is really up, so a failed call never leaves AISA replying to a switch.
      if (pendingSwitchFromChat && chat.started) chat.send("", { aisa_event: { type: "switching_to_voice", quoteId } }, { echo: false }).catch(() => {});
      pendingSwitchFromChat = false;
    }
    if (s !== "live" && s !== "connecting") {
      const mute = $('[data-action="mute"]');
      mute.setAttribute("aria-pressed", "false");
      mute.querySelector("[data-mute-label]").textContent = "Mute";
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
      transcript.note("The call couldn't connect. Everything is saved, so you can keep going here in chat.");
      if (!chat.started) startChat();
      return;
    }
    callWasLive = false;
    transcript.note("Call ended. You're back in chat, and everything you told AISA is kept.");
    // Step 7: the call's state and its last turns are in the Contact Profile; the flow loads them. This is only the
    // signal that the customer is back, so AISA speaks first.
    const note = { aisa_event: { type: "returned_from_voice", quoteId } };
    (chat.started ? chat.send("", note, { echo: false }) : chat.start({ ...entry, switchedFrom: "voice" })).then(resendScreen).catch((err) => say(err.message));
  },
});

// ---- Channel actions
function enterConversation() {
  document.body.classList.add("in-conversation");
}

async function startChat(intent) {
  enterConversation();
  store.set({ channel: "chat" });
  if (isPreview) return;
  try {
    await chat.start(intent ? { ...entry, intent } : entry);
  } catch (err) {
    transcript.note(`Chat couldn't connect (${err.message}).`);
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
    transcript.note(fromChat ? "Switching to voice. Allow the microphone if your browser asks." : "Starting a voice conversation in your browser. Allow the microphone if asked.");
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
    transcript.note(`Voice isn't available right now (${reason}). Everything is saved, so you can keep going here in chat.`);
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
  if (attachBusy()) return;
  setAttachPhase("opening", 12000);
  enterConversation();
  if (store.get().channel === "idle") return startChat("upload_dec_page");
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
// Read-only review panel (no form, per Travelers). Its buttons send ordinary customer messages, so AISA's tools
// record the confirmation or ask what to change; nothing on the page writes quote data.
// The topic word for each step ("my vehicle details") comes from the flow's catalog (rules.panel.steps[].topic).
const topic = (step) => step.topic || "quote";
const panel = createPanel($("[data-panel]"), {
  config: CONFIG,
  // "Everything looks right" stays a sentence: confirming the whole quote is the agent's confirm_quote step. A step's
  // "These are correct" is an event the flow applies in code (turn_router.js confirm_section).
  onConfirm: ({ step, all }) => all
    ? sendText("Yes, everything in my quote looks right.")
    : sendEvent(`Yes, my ${topic(step)} details are correct.`, { aisa_event: { type: "confirm_section", section: step.id, quoteId } }),
  onCorrect: ({ step }) => sendText(`I need to correct something in my ${topic(step)} details.`),
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

// ---- Wiring
const on = (action, fn) => document.querySelectorAll(`[data-action="${action}"]`).forEach((b) => b.addEventListener("click", fn));
on("start-chat", () => startChat());
on("start-voice", () => startVoice(false));
on("start-upload", requestUpload);
on("upload", requestUpload);
on("attach", requestUpload);
on("switch-voice", () => startVoice(true));
on("hang-up", () => (isPreview ? voice_previewEnd() : voice.end().catch((err) => say(err.message))));
on("mute", async (e) => {
  const btn = e.currentTarget;
  const muted = await voice.toggleMute();
  btn.setAttribute("aria-pressed", String(muted));
  btn.querySelector("[data-mute-label]").textContent = muted ? "Unmute" : "Mute";
});
on("person", talkToPerson);
on("toggle-panel", () => {
  if (phone.matches) return setDrawer(false); // on phones the panel's close button closes the drawer
  const hidden = document.body.classList.toggle("panel-hidden");
  screen.report({ panelOpen: !hidden });
  const tab = $(".panel-tab");
  tab.setAttribute("aria-expanded", String(!hidden));
  $("[data-tab-label]").textContent = hidden ? "Show quote" : "Hide quote";
});

const input = $("[data-composer-input]");
$("[data-composer-form]").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = "";
  sendText(text);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("[data-composer-form]").requestSubmit();
  }
});

let lastNotice = null;
let lastChoices = null;
store.subscribe((state) => {
  // A new screen in the panel: forget which one was showing until it announces itself.
  if (state.xappUrl !== xappKindUrl) {
    xappKind = null;
    xappKindUrl = state.xappUrl;
  }
  panel.render(state);
  followAttach(state);
  followDrawer(state);
  document.body.dataset.channel = state.channel;
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

// ---- Preview: plays a scripted conversation (placeholder data) so the layout can be reviewed without Cognigy.
function voice_previewEnd() {
  stopClock();
  store.set({ channel: "chat" });
  transcript.note("Call ended. You're back in chat, and everything you told AISA is kept.");
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
      if (step.note) transcript.note(step.note);
      if (step.bot) transcript.add({ from: "bot", text: step.bot, choices: step.choices || [], via: step.via || "chat" });
      if (step.user) transcript.add({ from: "user", text: step.user, via: step.via || "chat" });
      if (step.ui) store.applyUi(step.ui);
    }, t);
  }
}
