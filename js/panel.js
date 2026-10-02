import { STEPS, stepFor, labelForKey, stepIdForKey } from "./questions.js";
import { SOURCES, SOURCES_SHORT } from "./state.js";

const RECENT_MS = 8000; // how long a just-updated answer stays highlighted
import { el } from "./util.js";

const STATUS_LABELS = {
  collecting: null,
  quote_ready: "Quote ready",
  rating: "Preparing your rate",
  advisor_requested: "Advisor requested",
};

export function isAllowedXapp(url, suffixes) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && suffixes.some((s) => u.hostname.endsWith(s));
  } catch {
    return false;
  }
}

// The "Your quote" panel: a read-only view of what AISA has stored, one step at a time, filled live from aisa_ui.
// Travelers doesn't want a form experience (2026-10-01): answers only come from the conversation (chat or voice).
// The panel is for reviewing and confirming. "These are correct" and "Something's not right" send an ordinary
// customer message to AISA, so the conversation, its guardrails and the validator stay the only way data changes.
export function createPanel(root, { config, onConfirm, onCorrect, onPerson, onView }) {
  const body = root.querySelector("[data-panel-body]");
  const stepLabel = root.querySelector("[data-step-label]");
  const bar = root.querySelector("[data-progress]");
  const statusPill = root.querySelector("[data-status]");
  const effPill = root.querySelector("[data-eff]");
  let lastFilled = 0;
  const xappCard = root.querySelector("[data-xapp-card]");
  const xappFrame = root.querySelector("[data-xapp]");
  const xappLoading = root.querySelector("[data-xapp-loading]");
  const xappLink = root.querySelector("[data-xapp-link]");
  const xappStatus = root.querySelector("[data-xapp-status]");
  // After a screen submits, the xApp shell shows an empty "nothing to do" page until the flow sends something new. The
  // page covers it with a status line instead (for the upload screen: "reading your declaration page"); a new screen
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
  const dismissed = { xapp: null, advisor: null };
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

  // Short tag on screen, full wording as the tooltip and for screen readers.
  function sourceTag(f) {
    const short = SOURCES_SHORT[f.source];
    const long = SOURCES[f.source];
    if (f.confirmed === false) {
      const full = `${long || "Not confirmed yet"}. Please confirm.`;
      return el("span", { class: "src-tag src-check", title: full, "aria-label": full }, `${short || "Check"} · confirm`);
    }
    return short ? el("span", { class: `src-tag src-${f.source}`, title: long, "aria-label": long }, short) : null;
  }

  // Answers that just arrived or changed stay highlighted for a few seconds, so the customer can check them.
  const recent = new Map(); // key -> time it changed
  let lastSigs = null;
  function row(f) {
    const at = recent.get(f.key);
    const age = at ? Date.now() - at : Infinity;
    const fresh = age < RECENT_MS;
    // A negative delay resumes the fade where it was, so re-rendering doesn't restart it.
    return el("div", { class: `review-row${fresh ? " row-updated" : ""}`, "data-row": f.key, style: fresh ? `animation-delay:-${age}ms` : undefined },
      el("dt", {}, labelForKey(f.key) || f.label, fresh ? el("span", { class: "updated-mark", style: `animation-delay:-${age}ms` }, "Updated") : null),
      el("dd", {}, f.value, sourceTag(f)));
  }

  // Which answers are new or changed since the last update from the flow (value, source or confirmation). A channel
  // switch resends the same answers, so nothing lights up then.
  function trackChanges(fields) {
    const sigs = new Map([...fields.values()].filter((f) => f.value).map((f) => [f.key, `${f.value}|${f.source}|${f.confirmed}`]));
    const changed = lastSigs ? [...sigs.keys()].filter((k) => lastSigs.get(k) !== sigs.get(k)) : [];
    lastSigs = sigs;
    const now = Date.now();
    for (const k of changed) recent.set(k, now);
    if (changed.length) setTimeout(() => state && render(state), RECENT_MS + 50); // drop the highlight
    return changed;
  }

  const entityOf = (key) => { const m = key.match(/\[(\d+)\]/); return m ? Number(m[1]) : 0; };

  // Values for one step: grouped by vehicle, driver or incident, then in the order the question set asks them; keys
  // the catalog doesn't list (VIN, prefill extras) come last.
  function stepFields(step) {
    const order = new Map((step.fields || []).map((f, i) => [f.key, i]));
    const rank = (key) => order.get(key.split(".").pop()) ?? 999;
    return [...state.fields.values()]
      .filter((f) => f.section === step.id && f.value)
      .sort((a, b) => entityOf(a.key) - entityOf(b.key) || rank(a.key) - rank(b.key));
  }

  function renderStep(step) {
    const card = el("div", { class: "form-card review-card" }, el("h3", {}, step.heading || step.title));
    const rows = stepFields(step);
    if (!rows.length) {
      card.append(el("p", { class: "muted" }, "Nothing here yet. AISA fills this in as you talk."));
      return { node: card, rows };
    }
    if (step.entity) {
      const groups = new Map();
      for (const f of rows) {
        const i = entityOf(f.key);
        if (!groups.has(i)) groups.set(i, []);
        groups.get(i).push(f);
      }
      for (const [i, list] of groups) {
        const v = (name) => list.find((f) => f.key.endsWith(`.${name}`))?.value || "";
        const name = step.entity.name(v) || `${cap(step.entity.noun)} ${i + 1}`;
        card.append(el("h4", {}, name), el("dl", { class: "review-list" }, ...list.map(row)));
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
    for (const step of STEPS.filter((s) => s.fields)) {
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
    const advisor = el("button", { class: "btn btn-secondary", type: "button" }, "Talk to a licensed advisor");
    advisor.addEventListener("click", onPerson);
    wrap.append(advisor);
    // The advisor summary and the rate screen live in cards at the top of the panel; bring them back if dismissed.
    const again = [];
    if (state.xappUrl && dismissed.xapp === state.xappUrl) again.push(["Show the rate page again", "xapp"]);
    if (state.advisorSummary && dismissed.advisor === state.advisorSummary) again.push(["Show the advisor summary again", "advisor"]);
    for (const [label, which] of again) {
      const b = el("button", { class: "link-btn show-again", type: "button" }, label);
      b.addEventListener("click", () => { dismissed[which] = null; byCustomer = true; render(state); });
      wrap.append(el("div", {}, b));
    }
    return { node: wrap, rows: [] };
  }

  function go(delta) {
    const at = STEPS.findIndex((s) => s.id === viewStep);
    viewStep = STEPS[Math.max(0, Math.min(STEPS.length - 1, at + delta))].id;
    byCustomer = true;
    render(state);
  }

  let fieldsSeen = null;
  let scrollTo = null;
  function render(next) {
    state = next;
    // The flow sends the final field (e.g. the last policy answer) and the move to "review" or "rate" in the same
    // update: quote_ready and confirm_quote both land here. That milestone must win over the "jump to wherever the
    // last answer landed" heuristic below, or the customer never sees the review screen, only the last data step.
    let flowMoved = false;
    if (state.section && state.section !== lastFlowSection) {
      lastFlowSection = state.section;
      viewStep = state.section; // follow the conversation when AISA moves on
      flowMoved = true;
    }
    // New or changed answers win over the next question: show the step where they landed, so the customer sees what
    // AISA just stored and can check it. Bulk updates (declaration page, records) go to the first step they touch.
    if (state.fields !== fieldsSeen) {
      fieldsSeen = state.fields;
      const changed = trackChanges(state.fields);
      if (changed.length && !(flowMoved && (viewStep === "review" || viewStep === "rate"))) {
        const order = STEPS.map((st) => st.id);
        const target = changed.map((k) => state.fields.get(k)?.section || stepIdForKey(k)).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
        if (target) viewStep = target;
        scrollTo = changed.find((k) => (state.fields.get(k)?.section || stepIdForKey(k)) === target) || null;
      }
    }
    const step = stepFor(viewStep) || STEPS[0];
    const index = STEPS.indexOf(step);

    stepLabel.textContent = `Step ${index + 1}/${STEPS.length}: ${step.title}`;
    bar.style.width = `${Math.round(((index + 1) / STEPS.length) * 100)}%`;
    bar.parentElement.setAttribute("aria-valuenow", String(index + 1));
    const status = STATUS_LABELS[state.status];
    statusPill.hidden = !status;
    statusPill.textContent = status || "";
    // "Filled for you" counter: wording comes from the flow (rules.copy), the page only shows it.
    const eff = state.efficiency;
    const filled = eff && eff.filled > 0 && eff.chip ? eff.filled : 0;
    effPill.hidden = !filled;
    if (filled) {
      effPill.textContent = eff.chip;
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
    if (showAdvisor) renderAdvisorCard(advisorText, state.advisorRecord, state.advisorSummary);

    const built = step.summary ? renderReview() : step.rate ? renderRate() : renderStep(step);
    const footer = el("div", { class: "panel-actions" });
    const live = state.channel === "chat" || state.channel === "voice";
    // Confirm only what still needs it (document or records values marked "please confirm"), or the whole quote once
    // AISA says it's ready. The click sends a customer message; AISA records the confirmation through its tools.
    if (live && step.summary && state.status === "quote_ready") {
      const yes = el("button", { class: "btn btn-primary btn-wide", type: "button" }, "Everything looks right");
      yes.addEventListener("click", () => onConfirm({ step, all: true }));
      footer.append(yes);
    } else if (live && built.rows.some((f) => f.confirmed === false)) {
      const yes = el("button", { class: "btn btn-primary btn-wide", type: "button" }, "These are correct");
      yes.addEventListener("click", () => onConfirm({ step, all: false }));
      footer.append(yes);
    }
    if (live && built.rows.length && !step.rate) {
      const fix = el("button", { class: "link-btn", type: "button" }, "Something's not right? Tell AISA");
      fix.addEventListener("click", () => onCorrect({ step }));
      footer.append(fix);
    }
    const nav = el("div", { class: "step-nav" });
    if (index > 0) {
      const back = el("button", { class: "link-btn", type: "button" }, "Previous step");
      back.addEventListener("click", () => go(-1));
      nav.append(back);
    }
    if (index < STEPS.length - 1) {
      const fwd = el("button", { class: "link-btn", type: "button" }, "Next step");
      fwd.addEventListener("click", () => go(1));
      nav.append(fwd);
    }
    footer.append(nav);
    body.replaceChildren(built.node, footer);
    onView?.({ step: step.id, xapp: !!showXapp, advisor: showAdvisor }, byCustomer);
    byCustomer = false;
    if (scrollTo) {
      const rowEl = body.querySelector(`[data-row="${CSS.escape(scrollTo)}"]`);
      scrollTo = null;
      if (rowEl) rowEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  return { render, showXappStatus, clearXappStatus };
}

function renderAdvisorCard(container, record, fallbackText) {
  if (!record) {
    container.textContent = fallbackText;
    return;
  }
  const r = record;
  const items = [];

  items.push(el("dt", { class: "adv-label" }, "Customer"));
  items.push(el("dd", { class: "adv-value" }, r.name || "Unknown"));

  if (r.reason) {
    const reasons = { requested_human: "Customer requested", advice_request: "Coverage advice needed", eligibility: "Eligibility routing", under_18: "Under 18" };
    items.push(el("dt", { class: "adv-label" }, "Reason"));
    items.push(el("dd", { class: "adv-value" }, reasons[r.reason] || r.reason));
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
