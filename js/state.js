// Page-side quote state. The flow is the source of truth; this mirrors what it sends in `aisa_ui`,
// plus optimistic updates when the customer edits the "Your quote" form.
import { STEP_IDS, stepIdForKey } from "./questions.js";

export const SOURCES = {
  customer: "You told us",
  extracted: "From your declaration page",
  prefilled: "From our records",
  derived: "From your answers", // e.g. driver 1 name and DOB copied from the applicant
};
// Short tags for the panel (the long wording above is the tooltip and the screen reader label).
export const SOURCES_SHORT = {
  customer: "You",
  extracted: "Dec page",
  prefilled: "Records",
  derived: "Same as you",
};

const STATUSES = ["collecting", "quote_ready", "rating", "advisor_requested"];

export function createStore() {
  let state = {
    channel: "idle", // idle | chat | voice
    status: "collecting",
    section: null, // current step id, from the flow
    progress: null,
    fields: new Map(),
    xappUrl: null,
    advisorSummary: null,
    advisorRecord: null,
    notice: null,
    preview: false,
    // Step 7: the last quote state the flow sent (`aisa_ui.handoff`). Kept in memory only, never in browser
    // storage, and returned unchanged to the other channel when the customer switches. Not rendered.
    handoff: null,
    efficiency: null, // { total, asked, filled, fromDoc, fromRecords, fromAnswers, chip, line, detail } from the flow
  };
  const listeners = new Set();

  function emit() {
    listeners.forEach((fn) => fn(state));
  }

  return {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn);
      fn(state);
      return () => listeners.delete(fn);
    },
    set(patch) {
      state = { ...state, ...patch };
      emit();
    },
    applyUi(ui) {
      if (!ui || typeof ui !== "object") return;
      const fields = new Map(state.fields);
      for (const f of Array.isArray(ui.fields) ? ui.fields : []) {
        if (!f || typeof f.key !== "string") continue;
        fields.set(f.key, {
          key: f.key,
          label: String(f.label ?? f.key),
          value: f.value === null || f.value === undefined ? "" : String(f.value),
          source: SOURCES[f.source] ? f.source : "customer",
          section: STEP_IDS.includes(f.section) ? f.section : stepIdForKey(f.key),
          confirmed: f.confirmed,
        });
      }
      for (const key of Array.isArray(ui.removeKeys) ? ui.removeKeys : []) fields.delete(key);

      state = {
        ...state,
        fields,
        status: STATUSES.includes(ui.status) ? ui.status : state.status,
        section: STEP_IDS.includes(ui.section) ? ui.section : state.section,
        progress: ui.progress && Number.isFinite(ui.progress.done) && Number.isFinite(ui.progress.total) ? ui.progress : state.progress,
        xappUrl: "xappUrl" in ui ? ui.xappUrl || null : state.xappUrl,
        advisorSummary: typeof ui.advisorSummary === "string" ? ui.advisorSummary : state.advisorSummary,
        advisorRecord: ui.advisorRecord && typeof ui.advisorRecord === "object" ? ui.advisorRecord : state.advisorRecord,
        notice: typeof ui.notice === "string" ? ui.notice : state.notice,
        handoff: ui.handoff && typeof ui.handoff === "object" ? ui.handoff : state.handoff,
        efficiency: ui.efficiency && typeof ui.efficiency === "object" ? ui.efficiency : state.efficiency,
      };
      emit();
    },
  };
}

// Accepts the shapes Cognigy may deliver: bare object, JSON string, {data}, {body}, {info:{body}}.
export function extractUi(raw) {
  let value = raw;
  for (let i = 0; i < 4 && value != null; i++) {
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        return null;
      }
      continue;
    }
    if (typeof value !== "object") return null;
    if (value.aisa_ui) {
      // Send Metadata with "{{JSON.stringify(...)}}" delivers aisa_ui as a JSON string.
      if (typeof value.aisa_ui !== "string") return value.aisa_ui;
      try {
        return JSON.parse(value.aisa_ui);
      } catch {
        return null;
      }
    }
    value = value.data ?? value.body ?? value.info?.body ?? null;
  }
  return null;
}
