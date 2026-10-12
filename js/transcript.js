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

  function showOffered() {
    if (!offered) return;
    const { set, onPick } = offered;
    clearChoices();
    if (set.multi) return showMulti(set, onPick);
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

  // The open AISA bubble that the next piece of the same reply can join.
  let open = null;

  return {
    add({ from, text, choices = [], via, image, mid }) {
      const channel = via || "chat";
      const now = Date.now();
      const samePiece = channel === "voice" ? now - (open ? open.at : 0) < MERGE_WINDOW_MS.voice : !!mid && open && open.mid === mid;
      if (from === "bot" && text && !image && open && open.via === channel && list.lastElementChild === open.bubble && samePiece) {
        clearChoices();
        open.text = joinPiece(open.text, String(text).trim());
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
      if (from === "user") offered = null;
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
      open = from === "bot" && text && !image ? { bubble, body, text: String(text).trim(), via: channel, at: now, mid: mid || null } : null;
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
      offered = set && Array.isArray(set.options) && set.options.length ? { set, onPick } : null;
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
