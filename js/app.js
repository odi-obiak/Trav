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
  onUi: (ui) => store.applyUi(ui),
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
    // Step 7: the Contact Profile already has the call's state. Send only recent turns for context.
    const recent = transcript.recent();
    const note = { aisa_event: { type: "returned_from_voice", quoteId, recent } };
    (chat.started ? chat.send("", note, { echo: false }) : chat.start({ ...entry, switchedFrom: "voice", recent })).then(resendScreen).catch((err) => say(err.message));
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
    // Step 7: the Contact Profile already has the chat's state. Send only recent turns for spoken context.
    if (fromChat) console.log("[aisa-diag] startVoice: profile-based continuity, no handoff blob in SIP INFO");
    await voice.start({ ...entry, switchedFrom: fromChat ? "chat" : null, recent: fromChat ? transcript.recent() : null });
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

async function talkToPerson() {
  enterConversation();
  const data = { aisa_action: "live_agent", quoteId };
  if (isPreview) {
    transcript.add({ from: "user", text: CONFIG.liveAgentText, via: "chat" });
    return;
  }
  try {
    if (voice.inCall) await voice.send(CONFIG.liveAgentText, data);
    else {
      if (store.get().channel === "idle") store.set({ channel: "chat" });
      await chat.send(CONFIG.liveAgentText, data);
    }
  } catch (err) {
    say(err.message);
  }
}

// ---- Declaration page (Step 3): AISA opens an upload screen (xApp) in the panel, on chat and voice alike. The screen
// uploads the file straight to the bucket; the page never handles the document. These buttons only ask for the screen.
async function requestUpload() {
  enterConversation();
  if (store.get().channel === "idle") return startChat("upload_dec_page");
  if (isPreview) return;
  const data = { aisa_event: { type: "upload_requested", quoteId } };
  try {
    if (voice.inCall) await voice.send(CONFIG.uploadText, data);
    else await chat.send(CONFIG.uploadText, data);
  } catch (err) {
    say(err.message);
  }
}

// ---- Panel
// Read-only review panel (no form, per Travelers). Its buttons send ordinary customer messages, so AISA's tools
// record the confirmation or ask what to change; nothing on the page writes quote data.
const PANEL_TOPIC = { client: "personal", vehicles: "vehicle", drivers: "driver", losses: "driving history", policy: "current insurance" };
const topic = (step) => PANEL_TOPIC[step.id] || "quote";
const panel = createPanel($("[data-panel]"), {
  config: CONFIG,
  onConfirm: ({ step, all }) => sendText(all ? "Yes, everything in my quote looks right." : `Yes, my ${topic(step)} details are correct.`),
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
store.subscribe((state) => {
  // A new screen in the panel: forget which one was showing until it announces itself.
  if (state.xappUrl !== xappKindUrl) {
    xappKind = null;
    xappKindUrl = state.xappUrl;
  }
  panel.render(state);
  document.body.dataset.channel = state.channel;
  $("[data-preview]").hidden = !state.preview;
  if (state.notice && state.notice !== lastNotice) transcript.note(state.notice);
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
