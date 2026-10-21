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

  // Both chat and voice share the same userId ("aisa-<quoteId>") so they share the same Contact Profile. No
  // "-fromchat" suffix: the profile is the primary continuity mechanism, not a userId convention.
  // DEMO SHORTCUT: production passes the quote id only and the flow reads the draft quote from the system of record.
  // ---- Which way the call is dialled (2026-10-20)
  // The SDK reads the endpoint's config and dials one of two targets (getCallTarget() in @cognigy/click-to-call-sdk):
  //   - "endpoint": the endpoint id, when the config has organisationId, projectId and endpointSettings.endpointId;
  //   - "app": "app-<applicationSid>", after registering with the SIP username and password in the config.
  // Until 2026-10-20 InsuraMatch's config had no endpointId, so the SDK always took the "app" route. Some time that day
  // (between 05:04 and 20:35 UTC, nothing changed on our side) the config started including it. The SDK switched to the
  // "endpoint" route, InsuraMatch's Voice Gateway answers that INVITE with 404 Not Found, and every call from this page
  // failed before it was answered ("The call couldn't connect").
  // So the page fetches the config itself and hands the SDK a copy, through a local blob: URL. Fetching the config is the
  // only thing the SDK uses endpointUrl for, so nothing else changes. The page prefers the "app" route whenever the config
  // has its credentials, because that route works. If a call fails before it's answered, it tries the other route once
  // before giving up. That keeps calls working either way the platform goes next: if Voice Gateway learns to route by
  // endpoint id and the application credentials disappear, or if the endpoint id goes away again.
  // To raise with Cognigy support: the config now carries endpointId, and Voice Gateway 404s an INVITE to it.

  // The routes this config allows, best first.
  function routesFor(served) {
    const settings = (served && served.endpointSettings) || {};
    const sip = settings.sipConnectivityInfo || {};
    const appRoute = !!(sip.username && sip.password && sip.realm && sip.applicationSid);
    const endpointRoute = !!(served && served.organisationId && served.projectId && settings.endpointId);
    return [appRoute ? "app" : null, endpointRoute ? "endpoint" : null].filter(Boolean);
  }
  // A copy of the config that makes the SDK take the given route. Without endpointId the SDK falls back to the
  // application, so that's the only field to remove.
  function configFor(served, route) {
    const copy = JSON.parse(JSON.stringify(served));
    if (route === "app" && copy.endpointSettings) delete copy.endpointSettings.endpointId;
    return copy;
  }
  // Fresh for every call, so a change to the endpoint is picked up without reloading the page. null if it can't be read;
  // the SDK then fetches it itself and reports its own error.
  async function fetchServedConfig() {
    try {
      const res = await fetch(config.voiceEndpointUrl, { method: "GET", headers: { "Content-Type": "application/json" } });
      return res.ok ? await res.json() : null;
    } catch (err) {
      debug("voice config not read", err);
      return null;
    }
  }

  let servedConfig = null; // the endpoint's config as Cognigy served it, for this call
  let routesLeft = []; // routes not tried yet for this call
  let clientKey = null; // user id and route of the client we have
  let configBlobUrl = null;
  async function ensure(userId, route) {
    const key = userId + "|" + (route || "served");
    if (client && clientKey === key) return client;
    if (client) {
      await client.destroy().catch(() => {});
      client = null;
    }
    if (configBlobUrl) { URL.revokeObjectURL(configBlobUrl); configBlobUrl = null; }
    if (!config.voiceEndpointUrl) throw new Error("Voice endpoint not configured");
    const sdk = await import(config.clickToCallModuleUrl);
    const support = sdk.checkWebRTCSupport();
    if (!support.supported) throw new Error(`This browser can't make voice calls (${support.missing.join(", ")})`);
    if (route && servedConfig) {
      configBlobUrl = URL.createObjectURL(new Blob([JSON.stringify(configFor(servedConfig, route))], { type: "application/json" }));
    }
    client = await sdk.createWebRTCClient({
      endpointUrl: configBlobUrl || config.voiceEndpointUrl,
      userId,
      ...(config.iceServers?.length ? { pcConfig: { iceServers: config.iceServers } } : {}),
    });

    clientKey = key;
    // Events count only from the client the page is using now. A client replaced by a route retry (ensure destroys it)
    // is ignored. The client is reused for every later call on the same route, so this must not be tied to one call:
    // until 2026-10-21 it was tied to an attempt number, so from the second call on "answered" and "ended" were ignored,
    // the page never knew the call was live, and Hang up did nothing (Odiche: chat, call, chat, call).
    const self = client;
    const current = () => client === self;
    client.on("connecting", () => { if (current()) onStatus("connecting"); });
    client.on("answered", async () => {
      if (!current()) return;
      inCall = true;
      onStatus("live");
      if (pendingEntry) {
        debug("voice out", pendingEntry);
        const json = JSON.stringify(pendingEntry);
        // No text: the SDK's first argument arrives in the flow as the customer's words, so "aisa_entry" used to reach
        // the AI Agent as if said (the router now ignores it too). The 2 s resend is a safety net for a lost INFO; the
        // router answers only the first one and ends the duplicate silently.
        try {
          await client.sendInfo("", { aisa_entry_json: json });
        } catch (err) {
          debug("voice entry not sent", err);
        }
        setTimeout(async () => {
          if (!inCall) return;
          try { await client.sendInfo("", { aisa_entry_json: json }); } catch {}
        }, 2000);
      }
      entrySent = true;
      onReady?.();
    });
    client.on("transcription", (t) => {
      const from = t?.originator === "user" ? "user" : "bot";
      for (const m of t?.messages || []) {
        // Filter out SIP INFO body echoes: sendInfo("aisa_entry", ...) is entry data, not speech.
        // Voice Gateway echoes the body text as a transcription, showing "You spoken: aisa_entry".
        if (m?.text && m.text !== "aisa_entry") onMessage({ from, text: m.text, via: "voice" });
      }
    });
    client.on("infoReceived", (ev) => {
      // The SDK docs say {originator, info: {body: string}}, but the Click To Call tutorials
      // defensively check ev.info.body, ev.info.request.body and ev.body. Match that.
      const info = ev?.info || ev;
      const body = info?.body !== undefined ? info.body
        : info?.request?.body !== undefined ? info.request.body
        : ev?.body;
      debug("voice in", typeof body, typeof body === "string" ? body.slice(0, 200) : body);
      // Behind ?debug=1 only: SIP INFO bodies carry names, addresses and dates of birth.
      const ui = extractUi(body);
      if (ui) {
        debug("voice ui applied", Object.keys(ui));
        onUi(ui);
      } else {
        debug("voice ui not found in this SIP INFO body");
      }
    });
    const finish = (_session, endInfo) => {
      if (!current()) return;
      if (!inCall && !endInfo) return;
      // Failed before it was answered: try the next route once, quietly, before telling the page.
      if (!inCall && routesLeft.length) {
        const next = routesLeft.shift();
        debug("voice call failed before answer, trying route", next, endInfo);
        dial(next).catch((err) => {
          debug("voice retry failed", err);
          onStatus("ready");
          onEnded(endInfo);
        });
        return;
      }
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

  // One attempt on one route (null: the config exactly as served).
  async function dial(route) {
    const c = await ensure(identity.userId, route);
    onStatus("connecting");
    await c.connectAndCall();
  }

  return {
    // Must run from a user gesture (button click) so the browser allows microphone and audio playback.
    async start(entry) {
      pendingEntry = { ...entry, channel: "voice" };
      servedConfig = await fetchServedConfig();
      const routes = servedConfig ? routesFor(servedConfig) : [];
      debug("voice routes", routes.length ? routes : ["as served"]);
      // The first route now; the rest wait in routesLeft for a call that fails before it's answered (see finish).
      let route = routes.length ? routes[0] : null;
      routesLeft = routes.slice(1);
      // Registration can also fail before any INVITE goes out (bad credentials). That throws here, so the next route gets
      // its turn the same way.
      for (;;) {
        try {
          return await dial(route);
        } catch (err) {
          if (!routesLeft.length) throw err;
          debug("voice route failed to start, trying the next", route, err);
          route = routesLeft.shift();
        }
      }
    },
    // Always asks the client to end the call, even if the page missed "answered": the customer must never be left on a call
    // they can't hang up. Nothing live to end is not an error.
    async end() {
      if (!client) return;
      try {
        await client.endCall();
      } catch (err) {
        debug("voice end: nothing to end", err);
      }
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
      // Voice Gateway rewrites SIP INFO keys (dots and capitals), which broke row taps whose keys are field paths
      // ("vehicles.0.ownership"). Events go as one JSON string, the same as the entry (aisa_entry_json).
      if (data && data.aisa_event && typeof data.aisa_event === "object") {
        const { aisa_event: event, ...rest } = data;
        data = { ...rest, aisa_event_json: JSON.stringify(event) };
      }
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
