// Page-side quote state. The flow is the source of truth; this mirrors what it sends in `aisa_ui`. The page never
// writes quote data (the panel is read-only).
import { DEFAULT_CATALOG, readCatalog, stepIdForKey } from "./catalog.js";

// Where a value came from (customer, extracted, prefilled, derived). Wording comes from the catalog's sourceTags.
const SOURCE_IDS = ["customer", "extracted", "prefilled", "derived"];

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
    efficiency: null, // { total, asked, filled, fromDoc, fromRecords, fromAnswers, chip, line, detail } from the flow
    catalog: DEFAULT_CATALOG, // steps and wording, replaced by aisa_ui.panel from the flow (rules.panel)
    focus: null, // { section, key, seq }: where the flow wants the panel; seq changes with every new request
    choices: null, // { path, label, options } for the question AISA is asking now, shown as buttons; null when none
  };
  let focusSeq = 0;
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
      const catalog = readCatalog(ui.panel) || state.catalog;
      const stepIds = catalog.steps.map((s) => s.id);
      const fields = new Map(state.fields);
      for (const f of Array.isArray(ui.fields) ? ui.fields : []) {
        if (!f || typeof f.key !== "string") continue;
        fields.set(f.key, {
          key: f.key,
          label: typeof f.label === "string" ? f.label : "",
          order: Number.isFinite(f.order) ? f.order : 999,
          value: f.value === null || f.value === undefined ? "" : String(f.value),
          source: SOURCE_IDS.includes(f.source) ? f.source : "customer",
          section: stepIds.includes(f.section) ? f.section : stepIdForKey(catalog, f.key),
          confirmed: f.confirmed,
        });
      }
      const focus = ui.focus && typeof ui.focus === "object" && stepIds.includes(ui.focus.section)
        ? { section: ui.focus.section, key: typeof ui.focus.key === "string" ? ui.focus.key : null, seq: ++focusSeq }
        : state.focus;
      for (const key of Array.isArray(ui.removeKeys) ? ui.removeKeys : []) fields.delete(key);

      state = {
        ...state,
        fields,
        status: STATUSES.includes(ui.status) ? ui.status : state.status,
        catalog,
        focus,
        section: stepIds.includes(ui.section) ? ui.section : state.section,
        progress: ui.progress && Number.isFinite(ui.progress.done) && Number.isFinite(ui.progress.total) ? ui.progress : state.progress,
        xappUrl: "xappUrl" in ui ? ui.xappUrl || null : state.xappUrl,
        advisorSummary: typeof ui.advisorSummary === "string" ? ui.advisorSummary : state.advisorSummary,
        advisorRecord: ui.advisorRecord && typeof ui.advisorRecord === "object" ? ui.advisorRecord : state.advisorRecord,
        notice: typeof ui.notice === "string" ? ui.notice : state.notice,
        efficiency: ui.efficiency && typeof ui.efficiency === "object" ? ui.efficiency : state.efficiency,
        choices: "choices" in ui ? readChoices(ui.choices) : state.choices,
      };
      emit();
    },
  };
}

// The current question's options, from the flow. Only short strings are kept; anything else means no buttons.
function readChoices(c) {
  if (!c || typeof c !== "object" || typeof c.path !== "string" || !Array.isArray(c.options)) return null;
  const options = c.options.filter((o) => typeof o === "string" && o.trim() && o.length <= 60).slice(0, 12);
  return options.length ? { path: c.path, label: typeof c.label === "string" ? c.label : "", options } : null;
}

// Accepts the shapes Cognigy may deliver: bare object, JSON string, wrapped in data/payload/body/info.
// Voice Gateway wraps SIP INFO payloads unpredictably (data, payload, or double-data per the tutorials),
// so this uses a recursive search matching turn_router.js's find() pattern rather than a fixed chain.
export function extractUi(raw) {
  return findAisaUi(raw, 5);
}

function findAisaUi(value, depth) {
  if (value == null || depth < 0) return null;
  if (typeof value === "string") {
    if (value.length > 200000 || value.indexOf("aisa_ui") < 0) return null;
    try { return findAisaUi(JSON.parse(value), depth); } catch { return null; }
  }
  if (typeof value !== "object") return null;
  if (value.aisa_ui !== undefined && value.aisa_ui !== null) {
    const v = value.aisa_ui;
    if (typeof v === "object") return v;
    if (typeof v === "string") {
      try { return JSON.parse(v); } catch { return null; }
    }
    return null;
  }
  for (const k of ["data", "payload", "body", "info"]) {
    if (value[k] != null) {
      const hit = findAisaUi(value[k], depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}
