import { el } from "./util.js";

// One running conversation for chat, voice and typed-during-call turns, as in the wireframe.
export function createTranscript(root, { onChoice }) {
  const list = root.querySelector("[data-messages]");
  const typing = root.querySelector("[data-typing]");
  let lastChoices = null;
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

  return {
    add({ from, text, choices = [], via, image }) {
      clearChoices();
      if (text) history.push({ from: from === "user" ? "customer" : "aisa", text: String(text).slice(0, 400), via: via || "chat" });
      const who = from === "user" ? "You" : "AISA";
      const badge = from === "bot"
        ? el("span", { class: "msg-avatar", "aria-hidden": "true" }, "AI")
        : null;
      const tag = via === "voice" ? el("span", { class: "msg-via" }, "spoken") : null;
      const bubble = el("div", { class: `msg msg-${from}` },
        el("div", { class: "msg-who" }, badge, who, tag),
        text ? el("p", { class: "msg-text" }, text) : null,
        image ? el("img", { class: "msg-image", src: image, alt: "Your declaration page" }) : null);
      list.append(bubble);
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
      }
      scroll();
    },
    // Buttons with no bubble, e.g. "Attach declaration page" when AISA asks for the document.
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
      list.append(el("p", { class: "msg-note", role: "status" }, text));
      scroll();
    },
    typing(on) {
      typing.hidden = !on;
      if (on) scroll();
    },
    // Last turns, newest last, capped so the SIP INFO and chat payloads stay small.
    recent(max = 12) {
      return history.slice(-max);
    },
    get count() {
      return list.querySelectorAll(".msg").length;
    },
  };
}
