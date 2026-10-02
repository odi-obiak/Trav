import { debug } from "./util.js";
import { extractUi } from "./state.js";

// Browser voice over the Cognigy Click To Call SDK (documented: Click To Call > SDK). Replaces the floating widget
// so the call starts in one click from the page and its transcript lands in the same conversation as chat.
export function createVoice({ config, identity, onMessage, onUi, onStatus, onEnded, onReady }) {
  let client = null;
  let inCall = false;
  let muted = false;
  let pendingEntry = null;
  let entrySent = false; // the flow has the call's entry; before that, page data would arrive ahead of the quote

  // A call started from chat puts "-fromchat" in the opaque userId (sent in the SIP URI), so the flow's first voice
  // turn knows to skip the welcome before the quote state arrives by SIP INFO. Click To Call has no call-start data.
  // DEMO SHORTCUT: production passes the quote id only and the flow reads the draft quote from the system of record.
  let clientUserId = null;
  async function ensure(userId) {
    if (client && clientUserId === userId) return client;
    if (client) {
      await client.destroy().catch(() => {});
      client = null;
    }
    if (!config.voiceEndpointUrl) throw new Error("Voice endpoint not configured");
    const sdk = await import(config.clickToCallModuleUrl);
    const support = sdk.checkWebRTCSupport();
    if (!support.supported) throw new Error(`This browser can't make voice calls (${support.missing.join(", ")})`);
    client = await sdk.createWebRTCClient({
      endpointUrl: config.voiceEndpointUrl,
      userId,
      ...(config.iceServers?.length ? { pcConfig: { iceServers: config.iceServers } } : {}),
    });

    clientUserId = userId;
    client.on("connecting", () => onStatus("connecting"));
    client.on("answered", async () => {
      inCall = true;
      onStatus("live");
      if (pendingEntry) {
        debug("voice out", pendingEntry);
        try {
          // Sent as one JSON string: Voice Gateway rewrites SIP INFO data keys to snake_case and drops dots
          // ("quoteId" -> "quote_id", "client.firstName" -> "client_firstname"), which breaks the quote handoff.
          // String values pass through unchanged (seen in the flow logs, 2026-10-01).
          await client.sendInfo("", { aisa_entry_json: JSON.stringify(pendingEntry) });
        } catch (err) {
          debug("voice entry not sent", err);
        }
      }
      entrySent = true;
      onReady?.();
    });
    client.on("transcription", (t) => {
      const from = t?.originator === "user" ? "user" : "bot";
      for (const m of t?.messages || []) {
        if (m?.text) onMessage({ from, text: m.text, via: "voice" });
      }
    });
    client.on("infoReceived", (ev) => {
      debug("voice in", ev?.info?.body);
      const ui = extractUi(ev?.info?.body);
      if (ui) onUi(ui);
    });
    const finish = (_session, endInfo) => {
      if (!inCall && !endInfo) return;
      inCall = false;
      entrySent = false;
      muted = false;
      onStatus("ready");
      onEnded(endInfo);
    };
    client.on("ended", finish);
    client.on("failed", finish);
    client.on("error", (err) => debug("voice error", err));
    return client;
  }

  return {
    // Must run from a user gesture (button click) so the browser allows microphone and audio playback.
    async start(entry) {
      pendingEntry = { ...entry, channel: "voice" };
      const c = await ensure(entry.switchedFrom === "chat" ? `${identity.userId}-fromchat` : identity.userId);
      onStatus("connecting");
      await c.connectAndCall();
    },
    async end() {
      if (client && inCall) await client.endCall();
    },
    async toggleMute() {
      if (!client || !inCall) return muted;
      if (muted) await client.unmute();
      else await client.mute();
      muted = !muted;
      return muted;
    },
    // Typed text during a call goes to the flow as a SIP INFO, so the customer can type and talk.
    async send(text, data) {
      if (!client || !inCall) return false;
      debug("voice out", text, data);
      await client.sendInfo(text || "", data);
      if (text) onMessage({ from: "user", text, via: "typed" });
      return true;
    },
    get inCall() {
      return inCall;
    },
    get ready() {
      return inCall && entrySent;
    },
    get muted() {
      return muted;
    },
  };
}
