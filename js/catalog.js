// The quote panel's catalog: steps, step titles, tag and status wording.
//
// The flow sends the real catalog in `aisa_ui.panel` with the first update of each session (built from
// `quote_rules.json` `panel`), and every field arrives with its own `label` and `order` (each rules field's `display`).
// So the page keeps no field list. This file is only the starting catalog shown before that first update, and the
// checks that keep whatever the flow sends safe to render. Change wording in the rules, not here.

export const DEFAULT_CATALOG = {
  v: 1,
  steps: [
    { id: "client", title: "About You", topic: "personal", keyPrefix: "client" },
    { id: "vehicles", title: "Add Vehicles", topic: "vehicle", keyPrefix: "vehicle", entity: { noun: "vehicle", nameJoin: ["year", "make", "model"] } },
    { id: "drivers", title: "Add Drivers", heading: "Driver details", topic: "driver", keyPrefix: "driver", entity: { noun: "driver", nameJoin: ["firstName", "lastName"] } },
    { id: "losses", title: "Driving History", heading: "Accidents, tickets and claims", topic: "driving history", keyPrefix: "loss", entity: { noun: "incident", nameFirstOf: ["description", "type"] } },
    { id: "policy", title: "Current Insurance", topic: "current insurance", keyPrefix: "policy" },
    { id: "review", title: "Review", kind: "review" },
    { id: "rate", title: "Your Rate", kind: "rate" },
  ],
  sourceTags: {
    customer: { short: "You", long: "You told us" },
    extracted: { short: "Document", long: "From your document" },
    prefilled: { short: "Records", long: "From our records" },
    derived: { short: "Same as you", long: "From your answers" },
  },
  statusLabels: { quote_ready: "Quote ready", rating: "Preparing your rate", advisor_requested: "Advisor requested" },
  advisorReasons: { default: "A licensed advisor will help from here" },
};

const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : null);
const strList = (v) => (Array.isArray(v) ? v.map((x) => str(x, 40)).filter(Boolean).slice(0, 6) : null);
function strMap(v, max) {
  if (!v || typeof v !== "object") return null;
  const out = {};
  for (const [k, x] of Object.entries(v)) if (!k.startsWith("_") && str(x, max)) out[k] = str(x, max);
  return out;
}

// Keep only the shapes the panel knows how to draw, as plain strings. Anything else in the flow's catalog is ignored,
// so a bad catalog falls back to the default instead of breaking the panel.
export function readCatalog(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.steps)) return null;
  const steps = raw.steps
    .filter((s) => s && typeof s.id === "string" && /^[a-z_]{1,30}$/.test(s.id) && str(s.title, 60))
    .slice(0, 12)
    .map((s) => ({
      id: s.id,
      title: str(s.title, 60),
      heading: str(s.heading, 80),
      topic: str(s.topic, 40),
      keyPrefix: str(s.keyPrefix, 30),
      kind: s.kind === "review" || s.kind === "rate" ? s.kind : null,
      entity: s.entity && typeof s.entity === "object"
        ? { noun: str(s.entity.noun, 30) || "item", nameJoin: strList(s.entity.nameJoin), nameFirstOf: strList(s.entity.nameFirstOf) }
        : null,
    }));
  if (!steps.length) return null;
  const tags = {};
  for (const [k, t] of Object.entries(raw.sourceTags || {})) {
    if (t && typeof t === "object" && str(t.short, 30)) tags[k] = { short: str(t.short, 30), long: str(t.long, 80) || str(t.short, 30) };
  }
  return {
    v: 1,
    steps,
    sourceTags: Object.keys(tags).length ? tags : DEFAULT_CATALOG.sourceTags,
    statusLabels: strMap(raw.statusLabels, 60) || DEFAULT_CATALOG.statusLabels,
    advisorReasons: strMap(raw.advisorReasons, 80) || DEFAULT_CATALOG.advisorReasons,
  };
}

// "vehicle[1].year" -> the step whose keyPrefix is "vehicle"; unknown prefixes land on the first step.
export function stepIdForKey(catalog, key) {
  const prefix = String(key).split(/[.[]/)[0];
  const step = catalog.steps.find((s) => s.keyPrefix === prefix);
  return step ? step.id : catalog.steps[0].id;
}

// Only for a field that arrives without a label (an older flow sent the raw key): "annualMiles" -> "Annual miles".
export function humanize(name) {
  const words = String(name).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// A step's entity heading: "2021 Ford Escape", "Jane Smith", or the first of description / type for an incident.
export function entityName(entity, valueOf) {
  if (!entity) return "";
  if (entity.nameJoin) return entity.nameJoin.map(valueOf).filter(Boolean).join(" ");
  if (entity.nameFirstOf) return entity.nameFirstOf.map(valueOf).find(Boolean) || "";
  return "";
}
