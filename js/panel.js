import { humanize, entityName } from "./catalog.js";
import { el } from "./util.js";

const RECENT_MS = 8000; // how long a just-updated answer stays highlighted

export function isAllowedXapp(url, suffixes) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && suffixes.some((s) => u.hostname.endsWith(s));
  } catch {
    return false;
  }
}

// The "Your quote" panel: what AISA has stored, one step at a time, filled live from aisa_ui.
// It started read-only (2026-10-01: Travelers doesn't want a form experience). Since 2026-10-20 (Odiche) the customer can
// also change an answer (the pencil on a row) or remove a vehicle, driver or incident (the bin on its heading). The panel
// never changes its own data for that: it sends the change to the flow (onEdit, onRemove), which checks it like a typed
// answer, saves it and sends the result back. Until then the row shows "Saving…". Nothing is asked up front, so it is
// still not a form: answers come from the conversation, and the panel is for checking and fixing them.
export function createPanel(root, { config, onConfirm, onCorrect, onPerson, onView, onEdit, onRemove }) {
  const body = root.querySelector("[data-panel-body]");
  const stepLabel = root.querySelector("[data-step-label]");
  const bar = root.querySelector("[data-progress]");
  const statusPill = root.querySelector("[data-status]");
  const effPill = root.querySelector("[data-eff]");
  const stepList = root.querySelector("[data-step-list]"); // optional: older markup has no step list
  let lastFilled = 0;
  const xappCard = root.querySelector("[data-xapp-card]");
  const xappFrame = root.querySelector("[data-xapp]");
  const xappLoading = root.querySelector("[data-xapp-loading]");
  const xappLink = root.querySelector("[data-xapp-link]");
  const xappStatus = root.querySelector("[data-xapp-status]");
  // After a screen submits, the xApp shell shows an empty "nothing to do" page until the flow sends something new. The
  // page covers it with a status line instead (for the upload screen: "reading your document"); a new screen
  // from the flow, or the flow closing the card, clears it.
  let xappStatusFor = null;
  let xappSlowTimer = null;
  function clearXappStatus() {
    clearTimeout(xappSlowTimer);
    xappStatusFor = null;
    xappCard.classList.remove("handed-off");
    xappStatus.hidden = true;
    xappStatus.replaceChildren();
  }
  function showXappStatus({ text, slowText, slowAfterMs = 45000 }) {
    clearXappStatus();
    xappStatusFor = state?.xappUrl ?? null;
    const msg = el("p", {}, text);
    const extra = el("p", { class: "muted" });
    xappStatus.replaceChildren(el("span", { class: "spinner", "aria-hidden": "true" }), el("div", {}, msg, extra));
    xappStatus.hidden = false;
    xappCard.classList.add("handed-off");
    if (slowText) xappSlowTimer = setTimeout(() => { extra.textContent = slowText; }, slowAfterMs);
  }
  const advisorCard = root.querySelector("[data-advisor-card]");
  const advisorText = root.querySelector("[data-advisor-summary]");
  // Dismissed cards stay hidden until the flow sends something new (a new screen or a changed summary).
  const dismissed = { xapp: null, advisor: null, closed: null };
  xappFrame.addEventListener("load", () => { if (xappFrame.getAttribute("src")) xappLoading.hidden = true; });
  root.querySelectorAll("[data-dismiss]").forEach((b) => b.addEventListener("click", () => {
    const which = b.dataset.dismiss;
    dismissed[which] = which === "xapp" ? state.xappUrl : state.advisorSummary;
    byCustomer = true;
    render(state);
  }));

  let viewStep = "client";
  let byCustomer = false; // the next render follows something the customer did (on-screen awareness reports only those)
  let lastFlowSection = null;
  let state = null;

  // Steps and wording come from the flow's catalog (aisa_ui.panel, from quote_rules.json); see catalog.js.
  const steps = () => state.catalog.steps;
  const stepFor = (id) => steps().find((s) => s.id === id) || null;
  const isData = (step) => !step.kind;

  // Where an answer came from (2026-10-14, Sascha: the customer doesn't need a "You" tag on their own answers). Their own
  // answers and answers copied from them carry nothing; filled-in ones get a quiet "From our records" style note, and an
  // unconfirmed one keeps its "confirm" tag, since the customer has to act on it.
  const QUIET_SOURCES = new Set(["customer", "derived"]);
  function sourceTag(f) {
    const tag = state.catalog.sourceTags[f.source] || {};
    const short = tag.short;
    const long = tag.long;
    if (f.confirmed === false) {
      const full = `${long || "Not confirmed yet"}. Please confirm.`;
      return el("span", { class: "src-tag src-check", title: full, "aria-label": full }, `${short || "Check"} · confirm`);
    }
    if (!f.source || QUIET_SOURCES.has(f.source)) return null;
    return long || short ? el("span", { class: "src-note" }, long || short) : null;
  }

  // Answers that just arrived or changed stay highlighted for a few seconds, so the customer can check them.
  const recent = new Map(); // key -> time it changed
  let lastSigs = null;

  // ---- Changing and removing answers (2026-10-20)
  // editing: the row open for editing, with what the customer has typed so far. The panel is redrawn whenever the flow
  // sends an update (and when a highlight fades), so the draft lives here, not in the input, or it would be lost.
  let editing = null; // { key, draft, error }
  let confirming = null; // the vehicle, driver or incident path waiting for "Remove" or "Keep it"
  // What each vehicle, driver or incident is called on the panel ("2019 Honda Civic"), so the customer's bubble can say
  // which one they changed. Filled as the steps are drawn.
  const entityNames = new Map();
  const whereOf = (f) => (f.entity && entityNames.get(f.entity)) || null;
  // Sent to the flow and not answered yet: row key or entity path -> when. The flow's next update clears it (the value
  // changes, or the row goes); if the flow refused the change, AISA says so in the conversation and the row goes back to
  // normal after PENDING_MS.
  const pending = new Map();
  const PENDING_MS = 12000;
  const isPending = (id) => pending.has(id) && Date.now() - pending.get(id) < PENDING_MS;
  function markPending(id) {
    pending.set(id, Date.now());
    setTimeout(() => state && render(state), PENDING_MS + 50);
  }
  // Changes are only sent while the conversation is live (chat or a call), and not after a handover: the quote is with an
  // advisor then, and the flow would ignore them anyway.
  const canChange = () => (state.channel === "chat" || state.channel === "voice") && state.status !== "advisor_requested";

  function startEdit(f) {
    editing = { key: f.key, draft: f.edit.type === "multi" ? f.value.split(", ").filter(Boolean) : f.value, error: "" };
    confirming = null;
    byCustomer = true;
    render(state);
  }
  function stopEdit(f) {
    editing = null;
    render(state);
    body.querySelector(`[data-edit-for="${CSS.escape(f.key)}"]`)?.focus();
  }
  // The value to send, as the flow stores it: true or false for yes/no, the options joined for "pick several", trimmed
  // text otherwise. Returns null (and says why) when there is nothing to send.
  function valueToSend(f) {
    const draft = editing.draft;
    if (f.edit.type === "bool") return draft === "Yes" ? true : draft === "No" ? false : null;
    if (f.edit.type === "multi") {
      if (!draft.length) { editing.error = "Pick at least one, or remove this answer."; return null; }
      return draft.join(", ");
    }
    const text = String(draft).replace(/\s+/g, " ").trim();
    if (!text) { editing.error = "Type the new answer, or remove this answer."; return null; }
    return text;
  }
  function saveEdit(f) {
    const value = valueToSend(f);
    if (value === null) return render(state);
    const shown = value === true ? "Yes" : value === false ? "No" : value;
    if (shown === f.value) return stopEdit(f); // nothing changed, so nothing to send
    markPending(f.key);
    stopEdit(f);
    onEdit?.({ field: f, value, shown, where: whereOf(f) });
  }
  function removeAnswer(f) {
    markPending(f.key);
    stopEdit(f);
    const where = whereOf(f);
    onRemove?.({ path: f.path, name: where ? `the ${labelOf(f)} for the ${where}` : `the answer for ${labelOf(f)}`, keys: [f.key] });
  }

  // The editor that replaces a row's value: the right control for the answer, then Save, Cancel and Remove.
  function editor(f) {
    const id = `edit-${f.key.replace(/[^a-z0-9]/gi, "-")}`;
    const label = labelOf(f);
    let control;
    if (f.edit.type === "multi") {
      control = el("fieldset", { class: "edit-checks", id, "aria-label": label },
        ...f.edit.options.map((option) => {
          const box = el("input", { type: "checkbox", value: option, checked: editing.draft.includes(option) });
          box.addEventListener("change", () => {
            editing.draft = f.edit.options.filter((o) => (o === option ? box.checked : editing.draft.includes(o)));
          });
          return el("label", {}, box, " ", option);
        }));
    } else if (f.edit.type === "bool" || f.edit.type === "options") {
      const options = f.edit.type === "bool" ? ["Yes", "No"] : f.edit.options.slice();
      // A value the list doesn't have (an older answer) stays selectable, so opening the editor never changes it quietly.
      if (f.value && !options.includes(f.value)) options.unshift(f.value);
      control = el("select", { id, "aria-label": `New answer for ${label}` },
        ...options.map((option) => el("option", { value: option, selected: option === editing.draft }, option)));
      control.addEventListener("change", () => { editing.draft = control.value; });
    } else {
      control = el("input", { type: "text", id, maxlength: "200", autocomplete: "off", "aria-label": `New answer for ${label}` });
      control.value = editing.draft;
      control.addEventListener("input", () => { editing.draft = control.value; editing.error = ""; });
    }
    const save = el("button", { class: "tds-button--primary tds-button--small", type: "submit" }, "Save");
    const cancel = el("button", { class: "tds-button--tertiary tds-button--small link-btn", type: "button" }, "Cancel");
    const remove = el("button", { class: "tds-button--tertiary tds-button--small link-btn remove-link", type: "button" }, "Remove answer");
    cancel.addEventListener("click", () => stopEdit(f));
    remove.addEventListener("click", () => removeAnswer(f));
    const errorId = `${id}-error`;
    const error = editing.error ? el("p", { class: "edit-error", id: errorId, role: "alert" }, editing.error) : null;
    if (error) control.setAttribute("aria-describedby", errorId);
    const form = el("form", { class: "row-editor", "data-editor": f.key, novalidate: true },
      control, error, el("div", { class: "edit-actions" }, save, cancel, remove));
    form.addEventListener("submit", (e) => { e.preventDefault(); saveEdit(f); });
    // Escape cancels the edit only; it mustn't also close the quote drawer on a phone (app.js listens on the document).
    form.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); stopEdit(f); } });
    return form;
  }

  function row(f) {
    const at = recent.get(f.key);
    const age = at ? Date.now() - at : Infinity;
    const fresh = age < RECENT_MS;
    const label = labelOf(f);
    const changeable = canChange() && !!f.edit && !!f.path;
    const open = changeable && editing && editing.key === f.key;
    const saving = isPending(f.key);
    let action = null;
    if (changeable && !open) {
      // aria-disabled rather than disabled while saving, so focus can stay on it after Save.
      action = el("button", { class: "row-action", type: "button", "data-edit-for": f.key, "aria-label": `Change ${label}`, title: `Change ${label}`, "aria-disabled": saving ? "true" : undefined },
        icon("pencil-18"));
      action.addEventListener("click", () => { if (!isPending(f.key)) startEdit(f); });
    }
    // A negative delay resumes the fade where it was, so re-rendering doesn't restart it.
    return el("div", { class: `review-row${fresh ? " row-updated" : ""}${changeable ? " is-changeable" : ""}${open ? " is-editing" : ""}`, "data-row": f.key, style: fresh ? `animation-delay:-${age}ms` : undefined },
      el("dt", {}, label, fresh ? el("span", { class: "updated-mark", style: `animation-delay:-${age}ms` }, "Updated") : null),
      // The pencil sits inside the dd: a dl row may only hold dt and dd, or screen readers lose the list.
      open ? el("dd", {}, editor(f))
        : el("dd", {}, el("span", { class: "row-value" }, f.value, sourceTag(f), saving ? el("span", { class: "saving-note", role: "status" }, "Saving…") : null), action));
  }

  // The heading of one vehicle, driver or incident, with its bin. Removing asks first, in place: a whole car is a lot to
  // lose to a stray tap. Driver 0 is the customer and comes without an entity, so it has no bin.
  function entityHeading(name, entityPath) {
    const heading = el("h4", { class: "entity-heading" }, el("span", {}, name));
    if (!entityPath || !canChange()) return [heading];
    const removing = isPending(entityPath);
    const bin = el("button", { class: "row-action", type: "button", "data-remove-for": entityPath, "aria-label": `Remove the ${name}`, title: `Remove the ${name}`, disabled: removing },
      icon("trash-18"));
    bin.addEventListener("click", () => { confirming = entityPath; editing = null; byCustomer = true; render(state); body.querySelector("[data-keep]")?.focus(); });
    heading.append(removing ? el("span", { class: "saving-note", role: "status" }, "Removing…") : bin);
    if (confirming !== entityPath) return [heading];
    const yes = el("button", { class: "tds-button--primary tds-button--small", type: "button" }, "Remove");
    const keep = el("button", { class: "tds-button--tertiary tds-button--small link-btn", type: "button", "data-keep": "" }, "Keep it");
    yes.addEventListener("click", () => {
      confirming = null;
      markPending(entityPath);
      render(state);
      const keys = [...state.fields.values()].filter((f) => f.entity === entityPath).map((f) => f.key);
      onRemove?.({ path: entityPath, name: `the ${name}`, keys });
    });
    keep.addEventListener("click", () => { confirming = null; render(state); body.querySelector(`[data-remove-for="${CSS.escape(entityPath)}"]`)?.focus(); });
    const ask = el("div", { class: "remove-confirm", role: "group", "aria-label": `Remove the ${name}?` },
      el("p", {}, `Remove the ${name} from your quote?`), el("div", { class: "edit-actions" }, yes, keep));
    ask.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); keep.click(); } });
    return [heading, ask];
  }

  // Which answers are new or changed since the last update from the flow (value, source or confirmation). A channel
  // switch resends the same answers, so nothing lights up then.
  function trackChanges(fields) {
    const sigs = new Map([...fields.values()].filter((f) => f.value).map((f) => [f.key, `${f.value}|${f.source}|${f.confirmed}`]));
    const changed = lastSigs ? [...sigs.keys()].filter((k) => lastSigs.get(k) !== sigs.get(k)) : [];
    // The flow has answered a change we sent: the row changed or went. (A refused change leaves the row as it was; it
    // stops showing "Saving…" after PENDING_MS, and AISA says why in the conversation.)
    for (const k of changed) pending.delete(k);
    for (const k of [...pending.keys()]) {
      if (/^(vehicles|drivers|losses)\.\d+$/.test(k) ? ![...fields.values()].some((f) => f.entity === k) : !sigs.has(k)) pending.delete(k);
    }
    if (editing && !sigs.has(editing.key)) editing = null; // the row being edited was removed (by AISA, or another channel)
    lastSigs = sigs;
    const now = Date.now();
    for (const k of changed) recent.set(k, now);
    if (changed.length) setTimeout(() => state && render(state), RECENT_MS + 50); // drop the highlight
    return changed;
  }

  const entityOf = (key) => { const m = key.match(/\[(\d+)\]/); return m ? Number(m[1]) : 0; };
  // The flow sends each field's label. An older flow sent the bare key name instead; make that readable.
  const labelOf = (f) => {
    const leaf = f.key.split(".").pop();
    return f.label && f.label !== leaf ? f.label : humanize(leaf);
  };

  // Values for one step: grouped by vehicle, driver or incident, then in the rules' order (the order AISA asks);
  // values that aren't questions (VIN, prefill extras) come last.
  function stepFields(step) {
    return [...state.fields.values()]
      .filter((f) => f.section === step.id && f.value)
      .sort((a, b) => entityOf(a.key) - entityOf(b.key) || a.order - b.order);
  }

  function renderStep(step) {
    const card = el("div", { class: "form-card review-card" }, el("h3", {}, step.heading || step.title));
    const rows = stepFields(step);
    if (!rows.length) {
      card.append(el("p", { class: "muted" }, "Nothing here yet. AISA fills this in as you talk."));
      return { node: card, rows };
    }
    if (step.entity) {
      // A question about the whole step ("Any accidents, tickets or claims?") belongs to no vehicle, driver or incident:
      // it goes first, with no heading.
      const general = rows.filter((f) => !/\[\d+\]/.test(f.key));
      if (general.length) card.append(el("dl", { class: "review-list" }, ...general.map(row)));
      const groups = new Map();
      for (const f of rows.filter((x) => /\[\d+\]/.test(x.key))) {
        const i = entityOf(f.key);
        if (!groups.has(i)) groups.set(i, []);
        groups.get(i).push(f);
      }
      for (const [i, list] of groups) {
        const v = (name) => list.find((f) => f.key.endsWith(`.${name}`))?.value || "";
        const name = entityName(step.entity, v) || `${cap(step.entity.noun)} ${i + 1}`;
        const entityPath = list.find((f) => f.entity)?.entity || null;
        if (entityPath) entityNames.set(entityPath, name);
        card.append(...entityHeading(name, entityPath), el("dl", { class: "review-list" }, ...list.map(row)));
      }
    } else {
      card.append(el("dl", { class: "review-list" }, ...rows.map(row)));
    }
    return { node: card, rows };
  }

  function renderReview() {
    const wrap = el("div", { class: "form-card review-card" }, el("h3", {}, "Review your quote"));
    const eff = state.efficiency;
    if (eff && eff.filled > 0 && eff.line) {
      wrap.append(el("div", { class: "eff-card" },
        el("span", { class: "eff-num", "aria-hidden": "true" }, String(eff.filled)),
        el("p", { class: "eff-line" }, eff.line),
        eff.detail ? el("p", { class: "eff-detail" }, eff.detail) : null));
    }
    let rows = [];
    for (const step of steps().filter(isData)) {
      const list = stepFields(step);
      if (!list.length) continue;
      rows = rows.concat(list);
      wrap.append(el("h4", {}, step.title), el("dl", { class: "review-list" }, ...list.map(row)));
    }
    if (!rows.length) wrap.append(el("p", { class: "muted" }, "Nothing captured yet. Your answers appear here as you go."));
    return { node: wrap, rows };
  }

  function renderRate() {
    const wrap = el("div", { class: "form-card" }, el("h3", {}, "Your rate"));
    // DEMO SHORTCUT: rate page is simulated until Travelers confirms the real rate page transition (Step 8).
    wrap.append(el("p", { class: "muted" }, state.status === "rating" || state.status === "quote_ready"
      ? "Your quote is ready. The rate page opens here. (Simulated for the demo.)"
      : "Once AISA has everything it needs, your rate appears here."));
    const advisor = el("button", { class: "tds-button--secondary tds-button--small", type: "button" }, "Talk to a licensed advisor");
    advisor.addEventListener("click", onPerson);
    wrap.append(advisor);
    // The advisor summary and the rate screen live in cards at the top of the panel; bring them back if dismissed.
    const again = [];
    if (state.xappUrl && dismissed.xapp === state.xappUrl && dismissed.closed !== state.xappUrl) again.push(["Show the rate page again", "xapp"]);
    if (state.advisorSummary && dismissed.advisor === state.advisorSummary) again.push(["Show the advisor summary again", "advisor"]);
    for (const [label, which] of again) {
      const b = el("button", { class: "tds-button--tertiary tds-button--small link-btn show-again", type: "button" }, label);
      b.addEventListener("click", () => { dismissed[which] = null; byCustomer = true; render(state); });
      wrap.append(el("div", {}, b));
    }
    return { node: wrap, rows: [] };
  }

  function go(delta) {
    const list = steps();
    const at = list.findIndex((s) => s.id === viewStep);
    viewStep = list[Math.max(0, Math.min(list.length - 1, at + delta))].id;
    byCustomer = true;
    render(state);
  }

  // Every step at a glance: the one showing, the ones with answers (a tick), and a click to look at any of them. Looking
  // only changes what the panel shows; the conversation and the flow's focus are unchanged.
  function renderStepList(list, current) {
    stepList.replaceChildren(...list.map((s, i) => {
      const hasData = isData(s) && stepFields(s).length > 0;
      const isCurrent = s === current;
      // Horizontal stepper (2026-10-11): the name is a tooltip and screen-reader text; the step label under the row
      // names the step being shown.
      const b = el("button", { type: "button", title: s.title, "aria-current": isCurrent ? "step" : undefined },
        el("span", { class: "step-num", "aria-hidden": "true" }, String(i + 1)),
        el("span", { class: "step-title" }, `Step ${i + 1}: ${s.title}`),
        hasData && !isCurrent ? el("span", { class: "visually-hidden" }, " (has answers)") : null);
      b.addEventListener("click", () => {
        if (viewStep === s.id) return;
        viewStep = s.id;
        byCustomer = true;
        render(state);
      });
      return el("li", { class: [hasData ? "has-data" : "", isCurrent ? "is-current" : ""].join(" ").trim() }, b);
    }));
  }

  let fieldsSeen = null;
  let focusSeen = 0;
  let scrollTo = null;
  function render(next) {
    state = next;
    // Where to show is the flow's decision (aisa_ui.focus, build_ui.js): the step of what was just saved, or Review /
    // Rate when the quote reaches them. The page only follows, so there is no second rule here to disagree with it
    // (the 2026-10-01 bug where the last answer pulled the panel away from Review).
    if (state.focus && state.focus.seq !== focusSeen) {
      focusSeen = state.focus.seq;
      viewStep = state.focus.section;
      scrollTo = state.focus.key;
      lastFlowSection = state.section;
    } else if (state.section && state.section !== lastFlowSection) {
      // A flow that doesn't send focus yet (or the ?preview=1 script): follow the conversation's step.
      lastFlowSection = state.section;
      viewStep = state.section;
    }
    // Highlighting what just changed is presentation only, and stays on the page.
    if (state.fields !== fieldsSeen) {
      fieldsSeen = state.fields;
      trackChanges(state.fields);
    }
    const list = steps();
    const step = stepFor(viewStep) || list[0];
    const index = list.indexOf(step);

    stepLabel.textContent = step.title; // the stepper above already shows the number (2026-10-14, Sascha)
    bar.style.width = `${Math.round(((index + 1) / list.length) * 100)}%`;
    bar.parentElement.setAttribute("aria-valuenow", String(index + 1));
    bar.parentElement.setAttribute("aria-valuemax", String(list.length));
    if (stepList) renderStepList(list, step);
    const status = state.catalog.statusLabels[state.status] || null;
    statusPill.hidden = !status;
    statusPill.textContent = status || "";
    // "Filled for you" counter: wording comes from the flow (rules.copy), the page only shows it.
    const eff = state.efficiency;
    const filled = eff && eff.filled > 0 && eff.chip ? eff.filled : 0;
    effPill.hidden = !filled;
    if (filled) {
      effPill.textContent = eff.chip;
      effPill.title = typeof eff.chipNote === "string" ? eff.chipNote : ""; // how the time saved was estimated
      if (filled > lastFilled) { effPill.classList.remove("bump"); void effPill.offsetWidth; effPill.classList.add("bump"); }
    }
    lastFilled = filled;

    const allowedXapp = state.xappUrl && isAllowedXapp(state.xappUrl, config.allowedXappHostSuffixes);
    const showXapp = allowedXapp && dismissed.xapp !== state.xappUrl;
    if (xappStatusFor !== null && (!showXapp || xappStatusFor !== state.xappUrl)) clearXappStatus();
    xappCard.hidden = !showXapp;
    if (showXapp && xappFrame.getAttribute("src") !== state.xappUrl) {
      xappLoading.hidden = false;
      xappFrame.setAttribute("src", state.xappUrl);
      xappLink.href = state.xappUrl;
    }
    if (!showXapp && xappFrame.getAttribute("src")) xappFrame.removeAttribute("src");

    const showAdvisor = !!state.advisorSummary && dismissed.advisor !== state.advisorSummary;
    advisorCard.hidden = !showAdvisor;
    if (showAdvisor) renderAdvisorCard(advisorText, state.advisorRecord, state.advisorSummary, state.catalog.advisorReasons);

    const built = step.kind === "review" ? renderReview() : step.kind === "rate" ? renderRate() : renderStep(step);
    const footer = el("div", { class: "panel-actions" });
    const live = state.channel === "chat" || state.channel === "voice";
    // Confirm only what still needs it (document or records values marked "please confirm"), or the whole quote once
    // AISA says it's ready. The click sends a customer message; AISA records the confirmation through its tools.
    if (live && step.kind === "review" && state.status === "quote_ready") {
      const yes = el("button", { class: "tds-button--primary btn-wide", type: "button" }, "Everything looks right");
      yes.addEventListener("click", () => onConfirm({ step, all: true }));
      footer.append(yes);
    } else if (live && built.rows.some((f) => f.confirmed === false)) {
      const yes = el("button", { class: "tds-button--primary btn-wide", type: "button" }, "These are correct");
      yes.addEventListener("click", () => onConfirm({ step, all: false }));
      footer.append(yes);
    }
    if (live && built.rows.length && step.kind !== "rate") {
      const fix = el("button", { class: "tds-button--tertiary tds-button--small link-btn", type: "button" }, "Something's not right? Tell AISA");
      fix.addEventListener("click", () => onCorrect({ step }));
      footer.append(fix);
    }
    // Back on the left, Next on the right, always in the same place (an empty slot keeps the other one put).
    const nav = el("div", { class: "step-nav" });
    const chevron = icon;
    if (index > 0) {
      const back = el("button", { class: "tds-button--tertiary tds-button--small link-btn", type: "button", title: "Previous step" }, chevron("chevron-left-18"), "Back");
      back.addEventListener("click", () => go(-1));
      nav.append(back);
    } else nav.append(el("span", { "aria-hidden": "true" }));
    if (index < list.length - 1) {
      const fwd = el("button", { class: "tds-button--tertiary tds-button--small link-btn", type: "button", title: "Next step" }, "Next", chevron("chevron-right-18"));
      fwd.addEventListener("click", () => go(1));
      nav.append(fwd);
    } else nav.append(el("span", { "aria-hidden": "true" }));
    footer.append(nav);
    // A redraw while the customer is typing in the editor keeps them in it, with the cursor where it was.
    // Only when focus was in the panel: an update that lands while they type in the chat box mustn't pull them away.
    const active = document.activeElement;
    const focusWasInPanel = body.contains(active);
    const typingIn = active && active.closest && active.closest("[data-editor]") ? active : null;
    const caret = typingIn && typeof typingIn.selectionStart === "number" ? typingIn.selectionStart : null;
    // A pencil or bin that had focus gets it back on the redrawn panel (keyboard users would otherwise be sent to the top).
    const focusedAction = focusWasInPanel && active.dataset ? (active.dataset.editFor ? `[data-edit-for="${CSS.escape(active.dataset.editFor)}"]`
      : active.dataset.removeFor ? `[data-remove-for="${CSS.escape(active.dataset.removeFor)}"]` : null) : null;
    body.replaceChildren(built.node, footer);
    if (focusedAction) body.querySelector(focusedAction)?.focus();
    if (editing) {
      const control = body.querySelector(`[data-editor="${CSS.escape(editing.key)}"] input, [data-editor="${CSS.escape(editing.key)}"] select`);
      if (control && focusWasInPanel) {
        control.focus();
        if (caret !== null && typeof control.setSelectionRange === "function") control.setSelectionRange(caret, caret);
      }
    }
    onView?.({ step: step.id, xapp: !!showXapp, advisor: showAdvisor }, byCustomer);
    byCustomer = false;
    if (scrollTo) {
      const rowEl = body.querySelector(`[data-row="${CSS.escape(scrollTo)}"]`);
      scrollTo = null;
      if (rowEl) {
        // Keep the row clear of the pinned title and stepper (.panel-top) when scrolling it into view.
        const top = root.querySelector("[data-panel-top]");
        rowEl.style.scrollMarginTop = ((top && top.offsetHeight) || 0) + 8 + "px";
        rowEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  }

  // The screen itself finished without a result (the customer chose to keep talking): close its card, with no "show again"
  // (2026-10-14, live: the card stayed open on the xApp shell's empty "There is nothing to do here right now").
  // A cover over the screen that leaves the frame running underneath: hiding the frame (display: none) right after the
  // screen's "declined" stopped its submission from reaching AISA (2026-10-14, live).
  function coverXapp(text) {
    xappCard.querySelector(".xapp-cover")?.remove();
    xappCard.append(el("div", { class: "xapp-cover", role: "status" }, el("p", {}, text)));
  }
  function closeXapp() {
    xappCard.querySelector(".xapp-cover")?.remove();
    if (!state || !state.xappUrl) return;
    dismissed.xapp = state.xappUrl;
    dismissed.closed = state.xappUrl;
    clearXappStatus();
    render(state);
  }

  return { render, showXappStatus, clearXappStatus, closeXapp, coverXapp };
}

function renderAdvisorCard(container, record, fallbackText, reasons) {
  if (!record) {
    container.textContent = fallbackText;
    return;
  }
  const r = record;
  const items = [];

  items.push(el("dt", { class: "adv-label" }, "Customer"));
  items.push(el("dd", { class: "adv-value" }, r.name || "Unknown"));

  // Customer-facing wording from the rules (panel.advisorReasons). Never the raw reason code: 7A says AISA doesn't
  // explain eligibility, and codes like out_of_scope_drivers would.
  if (r.reason) {
    items.push(el("dt", { class: "adv-label" }, "Reason"));
    items.push(el("dd", { class: "adv-value" }, (reasons && (reasons[r.reason] || reasons.default)) || "A licensed advisor will help from here"));
  }

  if (r.words) {
    items.push(el("dt", { class: "adv-label" }, "In their words"));
    items.push(el("dd", { class: "adv-value adv-quote" }, `"${r.words}"`));
  }

  if (r.vehicles && r.vehicles.length) {
    items.push(el("dt", { class: "adv-label" }, r.vehicles.length === 1 ? "Vehicle" : "Vehicles"));
    items.push(el("dd", { class: "adv-value" }, ...r.vehicles.map((v, i) =>
      el("span", { class: "adv-pill" }, v)
    )));
  }

  if (r.drivers && r.drivers.length) {
    items.push(el("dt", { class: "adv-label" }, r.drivers.length === 1 ? "Driver" : "Drivers"));
    items.push(el("dd", { class: "adv-value" }, r.drivers.join(", ")));
  }

  if (r.losses) {
    items.push(el("dt", { class: "adv-label" }, "Losses"));
    items.push(el("dd", { class: "adv-value" }, ...r.losses.map((l) => el("span", { class: "adv-pill" }, l))));
  } else if (r.lossNone) {
    items.push(el("dt", { class: "adv-label" }, "Losses"));
    items.push(el("dd", { class: "adv-value adv-none" }, "None reported"));
  }

  if (r.progress) {
    items.push(el("dt", { class: "adv-label" }, "Quote progress"));
    items.push(el("dd", { class: "adv-value" }, `${r.progress.done} of ${r.progress.total} details`));
  }

  if (r.efficiency && r.efficiency.filled > 0) {
    items.push(el("dt", { class: "adv-label" }, "Filled by AISA"));
    items.push(el("dd", { class: "adv-value" }, `${r.efficiency.filled} of ${r.efficiency.total} answers`));
  }

  container.replaceChildren(el("dl", { class: "adv-grid" }, ...items));
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// An icon from the page's SVG sprite (index.html), hidden from screen readers: the button around it has the label.
function icon(id) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${id}`);
  svg.append(use);
  return svg;
}
