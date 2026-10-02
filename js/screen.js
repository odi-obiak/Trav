import { debug } from "./util.js";

// On-screen awareness: tells the flow what the customer is looking at, so AISA can answer "what's this?" or "I sent it"
// without asking what they mean (pattern from Durga's hands-on demo, 2026-10-01). The router stores it and ends the
// turn silently, so a report never makes AISA speak (except an upload failure during a call).
//
// Only customer-driven changes are reported (panel step, show or hide, dismissing a card, the upload screen's status).
// When AISA moves the panel, the flow already knows, so nothing is sent. Values are ids and codes from fixed lists,
// never free text. Sent as one JSON string (`aisa_screen_json`) because Voice Gateway rewrites SIP INFO data keys.
const DEBOUNCE_MS = 1200;

export function createScreenReporter({ send, enabled = true }) {
  let view = { panelOpen: true, step: null, cards: [], upload: null };
  let lastSent = null;
  let timer = null;

  function flush() {
    timer = null;
    const json = JSON.stringify({ v: 1, ...view });
    if (json === lastSent) return;
    // send() returns false while no conversation is running (nothing to tell yet); retry on the next change.
    Promise.resolve(send(json)).then((ok) => { if (ok !== false) lastSent = json; }).catch((err) => debug("screen report not sent", err));
  }

  return {
    // Keep the view current without sending (AISA moved the panel, so the flow knows).
    track(patch) {
      view = { ...view, ...patch };
    },
    // A change the customer made: send it once things settle. urgent skips the wait (an upload failure on a call).
    report(patch, { urgent = false } = {}) {
      view = { ...view, ...patch };
      if (!enabled) return;
      clearTimeout(timer);
      if (urgent) flush();
      else timer = setTimeout(flush, DEBOUNCE_MS);
    },
    // A new conversation or channel: the next report goes out even if the view hasn't changed.
    reset() {
      lastSent = null;
    },
    get view() {
      return view;
    },
  };
}
