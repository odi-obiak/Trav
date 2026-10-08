import { debug } from "./util.js";
import { extractUi } from "./state.js";

// Inline chat over the Cognigy Socket.IO client (documented: Endpoint reference > Socket.IO), connected to the
// existing Webchat v3 endpoint. Webchat v3 itself only renders as a floating window, and the wireframe puts the
// conversation inline, so the page renders messages itself.
//
// Trade-off: Webchat's built-in home screen, privacy notice and rich templates do not apply here. The page carries
// the disclosure, and the flow should send quick replies or buttons in the default (`_default`) format.
export function createChat({ config, identity, onMessage, onUi, onStatus, onTyping }) {
  let client = null;
  let connecting = null; // one shared connect, so a second caller waits for it instead of using a half-open client
  let started = false;
  // The start message carries aisa_entry (quote id, attribution). Anything sent while it's still connecting waits for it;
  // otherwise the socket's buffer sends that message first and the session starts with no quote id (found 2026-10-01).
  let startSent = Promise.resolve();

  function splitConfigUrl(url) {
    const u = new URL(url);
    const token = u.pathname.replace(/^\/+|\/+$/g, "");
    return { base: u.origin, token };
  }

  function ensure() {
    if (!connecting) connecting = connect().catch((err) => { connecting = null; client = null; throw err; });
    return connecting;
  }

  async function connect() {
    if (!config.webchatConfigUrl) throw new Error("Chat endpoint not configured");
    onStatus("connecting");
    const { SocketClient } = await import(config.socketClientModuleUrl);
    const { base, token } = splitConfigUrl(config.webchatConfigUrl);
    client = new SocketClient(base, token, {
      userId: identity.userId,
      sessionId: identity.chatSessionId,
      forceWebsockets: true,
    });
    client.on("output", (output) => {
      debug("chat in", output);
      onTyping(false);
      const ui = extractUi(output?.data);
      if (ui) onUi(ui);
      const text = typeof output?.text === "string" ? output.text.trim() : "";
      const choices = readChoices(output?.data);
      // Data-only outputs (aisa_ui updates) never render as empty bubbles.
      // Streamed pieces of one AI Agent reply share _cognigy._messageId; the page joins only those into one bubble.
      const mid = output?.data?._cognigy?._messageId || null;
      if (text || choices.length) onMessage({ from: "bot", text, choices, via: "chat", mid });
    });
    client.on("finalPing", () => onTyping(false));
    client.on("error", (err) => {
      debug("chat error", err);
      onTyping(false);
      onStatus("error");
    });
    await client.connect();
    onStatus("ready");
    return client;
  }

  return {
    async start(entry) {
      if (started) return startSent;
      started = true;
      startSent = ensure().then((c) => {
        onTyping(true);
        c.sendMessage(config.firstChatMessage, { aisa_entry: { ...entry, channel: "chat" } });
      });
      startSent.catch(() => { started = false; startSent = Promise.resolve(); });
      return startSent;
    },
    // Sends a customer message. Pass echo:false for data-only events the customer did not type, and typing:false for
    // ones AISA won't answer (screen reports), so no typing indicator waits for a reply that never comes.
    async send(text, data, { echo = true, typing = true } = {}) {
      await startSent;
      const c = await ensure();
      started = true;
      if (echo && text) onMessage({ from: "user", text, via: "chat" });
      if (typing) onTyping(true);
      debug("chat out", text, data);
      c.sendMessage(text || "", data);
    },
    get started() {
      return started;
    },
  };
}

// Quick replies and postback buttons from Cognigy's default output format.
function readChoices(data) {
  const d = data?._cognigy?._default;
  const quick = d?._quickReplies?.quickReplies || [];
  const buttons = d?._buttons?.buttons || [];
  return [...quick, ...buttons]
    .filter((b) => b && b.title && (b.type ?? "postback") === "postback")
    .map((b) => ({ title: String(b.title), payload: String(b.payload ?? b.title) }))
    .slice(0, 6);
}
