import { el } from "./util.js";

// One running conversation for chat, voice and typed-during-call turns, as in the wireframe.
// AISA's replies arrive in pieces: the AI Agent streams and cuts at line breaks and sentence ends (voice needs that for
// speed), so on chat a list would otherwise be one bubble per bullet. Chat: pieces with the same message id
// (_cognigy._messageId, one per AI Agent reply) join one bubble; flow messages without an id (the welcome, notices)
// stay separate. Voice transcripts carry no id, so back-to-back pieces close in time join instead.
const MERGE_WINDOW_MS = { voice: 10000 };
const BULLET = /^\s*([-*\u2022]|\d{1,2}[.)])\s+/;
// A bold-only line ("**Vehicles**") is a group title in a confirmation (2026-10-09): it always starts its own line, and
// so does whatever follows it, or the stream's pieces would run the title and its first item together.
const HEADING = /^\s*\*\*[^*]+\*\*:?\s*$/;
function joinPiece(prev, next) {
  const lastLine = prev.split("\n").pop();
  if (HEADING.test(next) || HEADING.test(lastLine)) return prev + "\n" + next;
  if (BULLET.test(next)) return prev + "\n" + next;
  if (/:\s*$/.test(prev)) return prev + "\n" + next;
  // "(yes or no)" after "- Is this also your mailing address?" belongs to that bullet.
  if (BULLET.test(lastLine)) return /^[(a-z]/.test(next) ? prev + " " + next : prev + "\n" + next;
  return prev + " " + next;
}

// Light formatting for AISA's text: "- " / "* " / "1." lines become a list, **bold** becomes bold, other lines become
// paragraphs. Built from text nodes only, never innerHTML, so nothing in a message can inject markup.
function inline(line) {
  const out = [];
  const parts = String(line).split(/(\*\*[^*]+\*\*)/);
  for (const part of parts) {
    if (!part) continue;
    const m = part.match(/^\*\*([^*]+)\*\*$/);
    out.push(m ? el("strong", {}, m[1]) : part);
  }
  return out;
}
function formatText(text) {
  const nodes = [];
  let list = null;
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line) { list = null; continue; }
    const m = line.match(BULLET);
    if (m) {
      const ordered = /\d/.test(m[1]);
      if (!list || list.ordered !== ordered) {
        list = { ordered, node: el(ordered ? "ol" : "ul", { class: "msg-list" }) };
        nodes.push(list.node);
      }
      list.node.append(el("li", {}, ...inline(line.slice(m[0].length))));
    } else {
      list = null;
      nodes.push(el("p", { class: HEADING.test(line) ? "msg-text msg-heading" : "msg-text" }, ...inline(line)));
    }
  }
  return nodes;
}

export function createTranscript(root, { onChoice }) {
  const list = root.querySelector("[data-messages]");
  const typing = root.querySelector("[data-typing]");
  let lastChoices = null;
  // Options for the question AISA is asking now (aisa_ui.choices). They stay under AISA's latest message while its reply
  // streams in, and go away once the customer answers (a tap or a typed reply) or the flow moves on.
  let offered = null;
  // What was said, kept in memory for the channel switch (Step 7): the other channel gets the last few turns so AISA
  // can carry on mid-thought. Never stored on the device.
  const history = [];

  function scroll() {
    list.scrollTop = list.scrollHeight;
  }

  function clearChoices() {
    lastChoices?.remove();
    lastChoices = null;
  }

  // "Select all that apply": toggle buttons (aria-pressed), "None of these" clears the rest, and Done sends the ticked
  // labels (an empty list for "None of these"). Done stays disabled until something is chosen.
  function showMulti(set, onPick) {
    const picked = new Set();
    let none = false;
    const toggles = set.options.map((value) => {
      const b = el("button", { class: "choice choice-toggle", type: "button", "aria-pressed": "false" }, value);
      b.addEventListener("click", () => {
        if (picked.has(value)) picked.delete(value); else picked.add(value);
        none = false;
        sync();
      });
      return b;
    });
    const noneBtn = el("button", { class: "choice choice-toggle", type: "button", "aria-pressed": "false" }, set.none);
    noneBtn.addEventListener("click", () => {
      none = !none;
      if (none) picked.clear();
      sync();
    });
    const done = el("button", { class: "choice choice-primary", type: "button", disabled: "" }, "Done");
    done.addEventListener("click", () => {
      if (!picked.size && !none) return;
      offered = null;
      clearChoices();
      onPick(set.options.filter((o) => picked.has(o)));
    });
    function sync() {
      toggles.forEach((b, i) => b.setAttribute("aria-pressed", String(picked.has(set.options[i]))));
      noneBtn.setAttribute("aria-pressed", String(none));
      done.disabled = !picked.size && !none;
    }
    lastChoices = el("div", { class: "choices choices-multi", role: "group", "aria-label": (set.label || "Choose") + ", select all that apply" },
      el("span", { class: "choices-hint" }, "Select all that apply"), ...toggles, noneBtn, done);
    list.append(lastChoices);
  }

  // A question asked as one group (2026-10-11): each part with options gets its own labelled row of buttons; one per row
  // can be picked (aria-pressed, tap again to clear) and Done sends { rowPath: option } for the rows answered. A single
  // row needs no Done: a tap answers it.
  function showRows(set, onPick) {
    if (set.rows.length === 1 && !set.rows[0].multi) {
      const r = set.rows[0];
      return showSingle({ path: r.path, label: r.label, options: r.options }, (value) => onPick({ [r.path]: value }));
    }
    const picked = {};
    const done = el("button", { class: "choice choice-primary", type: "button", disabled: "" }, "Done");
    const rowEls = set.rows.map((r) => {
      // A pick-several row (multi, e.g. Travelers policies): any number of options, sent as "Auto, Homeowners".
      const isOn = (value) => (r.multi ? (picked[r.path] || "").split(", ").includes(value) : picked[r.path] === value);
      const buttons = r.options.map((value) => {
        const b = el("button", { class: "choice choice-toggle", type: "button", "aria-pressed": "false" }, value);
        b.addEventListener("click", () => {
          if (r.multi) {
            const on = (picked[r.path] || "").split(", ").filter(Boolean);
            const next = on.includes(value) ? on.filter((x) => x !== value) : on.concat(value);
            picked[r.path] = next.length ? r.options.filter((o) => next.includes(o)).join(", ") : undefined;
          } else picked[r.path] = picked[r.path] === value ? undefined : value;
          buttons.forEach((x, i) => x.setAttribute("aria-pressed", String(isOn(r.options[i]))));
          done.disabled = !set.rows.some((row) => picked[row.path]);
        });
        return b;
      });
      const label = (r.label || "Choose one") + (r.multi ? " (pick any)" : "");
      return el("div", { class: "choice-row", role: "group", "aria-label": label },
        el("span", { class: "choice-row__label" }, label), el("div", { class: "choice-row__options" }, ...buttons));
    });
    done.addEventListener("click", () => {
      const answer = {};
      for (const r of set.rows) if (picked[r.path]) answer[r.path] = picked[r.path];
      if (!Object.keys(answer).length) return;
      offered = null;
      clearChoices();
      onPick(answer);
    });
    lastChoices = el("div", { class: "choices choices-rows", role: "group", "aria-label": set.label || "Your answers" },
      ...rowEls, el("div", { class: "choice-row__done" }, done,
        el("span", { class: "choices-hint" }, "Or type your answer. Anything you skip, AISA asks next.")));
    list.append(lastChoices);
  }

  function showSingle(set, onPick) {
    lastChoices = el("div", { class: "choices", role: "group", "aria-label": set.label || "Choose an answer" },
      ...set.options.map((value) => {
        const b = el("button", { class: "choice", type: "button" }, value);
        b.addEventListener("click", () => {
          offered = null;
          clearChoices();
          onPick(value);
        });
        return b;
      }));
    list.append(lastChoices);
  }

  function showOffered() {
    if (!offered) return;
    const { set, onPick } = offered;
    clearChoices();
    if (set.rows) return showRows(set, onPick);
    if (set.multi) return showMulti(set, onPick);
    return showSingle(set, onPick);
  }

  // The open AISA bubble that the next piece of the same reply can join.
  let open = null;
  // The flow says when an acknowledgement (7B rapport, "I see you recently moved...") may open AISA's next reply
  // (aisa_ui.ack). The stream drops line breaks, so that opening sentence is given its own line here (Odiche, 2026-10-12).
  let ackUntil = 0;

  return {
    add({ from, text, choices = [], via, image, mid }) {
      const channel = via || "chat";
      const now = Date.now();
      const samePiece = channel === "voice" ? now - (open ? open.at : 0) < MERGE_WINDOW_MS.voice : !!mid && open && open.mid === mid;
      if (from === "bot" && text && !image && open && open.via === channel && list.lastElementChild === open.bubble && samePiece) {
        clearChoices();
        const piece = String(text).trim();
        // The acknowledgement is the reply's first sentence, a statement; a reply that opens with a question has none.
        open.text = open.ack && open.pieces === 1 && !/\?\s*$/.test(open.text) ? open.text + "\n" + piece : joinPiece(open.text, piece);
        open.pieces += 1;
        open.at = now;
        open.body.replaceChildren(...formatText(open.text));
        const h = history[history.length - 1];
        if (h && h.from === "aisa") h.text = open.text.slice(0, 600);
        if (choices.length) this.actions(choices);
        else showOffered();
        scroll();
        return;
      }
      clearChoices();
      if (from === "user") { offered = null; ackUntil = 0; }
      // Only AISA's own reply (the AI Agent's, which has a message id on chat) can carry it, not a flow message before it.
      const ack = from === "bot" && !!text && !image && (channel === "voice" || !!mid) && Date.now() < ackUntil;
      if (ack) ackUntil = 0;
      if (text) history.push({ from: from === "user" ? "customer" : "aisa", text: String(text).slice(0, 600), via: channel });
      const who = from === "user" ? "You" : "AISA";
      const badge = from === "bot"
        ? el("span", { class: "msg-avatar", "aria-hidden": "true" }, "AI")
        : null;
      const tag = via === "voice" ? el("span", { class: "msg-via" }, "spoken") : null;
      const body = el("div", { class: "msg-body tds-chat__message-content" }, ...(text ? (from === "bot" ? formatText(text) : [el("p", { class: "msg-text" }, text)]) : []));
      // TDS chat message: plain for AISA (long replies), bubble for the customer (TDS AI & Chat guidance).
      const bubble = el("div", { class: `msg msg-${from} tds-chat__message${from === "user" ? " tds-chat__message--bubble" : ""}` },
        el("div", { class: "msg-who tds-chat__message-header" }, badge, el("span", { class: "tds-chat__message-name" }, who), tag),
        body,
        image ? el("img", { class: "msg-image", src: image, alt: "Your document" }) : null);
      list.append(bubble);
      open = from === "bot" && text && !image ? { bubble, body, text: String(text).trim(), via: channel, at: now, mid: mid || null, ack, pieces: 1 } : null;
      if (choices.length) {
        lastChoices = el("div", { class: "choices", role: "group", "aria-label": "Suggested replies" },
          ...choices.map((c) => {
            const b = el("button", { class: "choice", type: "button" }, c.title);
            b.addEventListener("click", () => {
              clearChoices();
              onChoice(c);
            });
            return b;
          }));
        list.append(lastChoices);
      } else if (from === "bot") showOffered();
      scroll();
    },
    // The question's options from the flow; onPick(value) sends the tap. null clears them.
    offer(set, onPick) {
      offered = set && ((Array.isArray(set.options) && set.options.length) || (Array.isArray(set.rows) && set.rows.length)) ? { set, onPick } : null;
      clearChoices();
      showOffered();
      scroll();
    },
    // Buttons with no bubble, e.g. "Share document" when AISA asks for a file.
    actions(choices) {
      clearChoices();
      lastChoices = el("div", { class: "choices", role: "group", "aria-label": "Actions" },
        ...choices.map((c) => {
          const b = el("button", { class: `choice${c.primary ? " choice-primary" : ""}`, type: "button" }, c.title);
          b.addEventListener("click", () => {
            clearChoices();
            onChoice(c);
          });
          return b;
        }));
      list.append(lastChoices);
      scroll();
    },
    // aisa_ui.ack: the next AISA reply may open with an acknowledgement (see ackUntil).
    expectAck() { ackUntil = Date.now() + 60000; },
    note(text) {
      open = null;
      list.append(el("p", { class: "msg-note", role: "status" }, text));
      scroll();
    },
    typing(on) {
      typing.hidden = !on;
      if (on) scroll();
    },
    get count() {
      return list.querySelectorAll(".msg").length;
    },
  };
}
