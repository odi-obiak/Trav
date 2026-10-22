// PAP conversations: the personal agent talks to AISA (the company agent) for its User.
//   POST /api/pap/conversations                 start, with the agent's first message
//   POST /api/pap/conversations/{id}/messages   a message
//   GET  /api/pap/conversations/{id}/events     always empty here (see below)
//   POST /api/pap/conversations/{id}/handoff    ask for a person
//   POST /api/pap/conversations/{id}/close      end
// vercel.json rewrites the paths to ?id=&action=.
// DEMO SHORTCUT: AISA's reply comes back in the response to each message, because nothing is stored between calls.
// The spec has replies read from /events with cursors; production keeps events in the session store.
import { authenticate, newConversation, openConversation, callAisa, sendError, bodyOf, origin, PapError } from "../../pap/lib.js";

export default async function handler(req, res) {
  const id = req.query.id ? String(req.query.id) : "";
  const action = req.query.action ? String(req.query.action) : "";
  const htu = `${origin(req)}/api/pap/conversations${id ? "/" + id : ""}${action ? "/" + action : ""}`;
  try {
    const session = await authenticate(req, htu);
    res.setHeader("Cache-Control", "no-store");

    if (!id) {
      if (req.method !== "POST") throw new PapError(405, "invalid_request", "POST to start a conversation");
      const message = bodyOf(req);
      const { conversationId, quoteId } = newConversation(session);
      // AISA is told who it's talking to: a personal agent the gateway verified, acting for a signed-out User.
      // No `ui`, so AISA takes its no-page path (options in words, no buttons).
      const start = await callAisa(quoteId, "", {
        aisa_entry: { quoteId, actor: "agent", agent: { client_id: session.client_id, name: session.client_name }, signedIn: false },
      });
      const first = message.text || message.data ? await callAisa(quoteId, message.text, { pap: papData(message) }) : { messages: [], quote: {} };
      return res.status(201).json({
        conversation_id: conversationId, status: "idle", responder: "agent",
        messages: start.messages.concat(first.messages), quote: mergeQuote(start.quote, first.quote),
      });
    }

    const { quoteId } = openConversation(session, id);
    if (action === "messages" && req.method === "POST") {
      const message = bodyOf(req);
      if (!message.text && !message.data) throw new PapError(400, "invalid_request", "A message needs text or data");
      const reply = await callAisa(quoteId, message.text, { pap: papData(message) });
      return res.status(202).json({ status: reply.quote.status === "advisor_requested" ? "queued" : "idle", responder: "agent", messages: reply.messages, quote: reply.quote });
    }
    if (action === "events" && req.method === "GET") {
      return res.status(200).json({ events: [], cursor: String(req.query.cursor || "0"), has_more: false, status: "idle", responder: "agent" });
    }
    if (action === "handoff" && req.method === "POST") {
      // AISA's "Talk to a person" path. Transfers are off in this build, so no person joins (spec: back to idle with a message).
      const reply = await callAisa(quoteId, "", { aisa_action: "live_agent", pap: { sender: "agent" } });
      reply.messages.push({ id: "m_handoff", role: "company", sender: "agent", text: "No advisor is connected in this prototype, so the conversation stays with AISA." });
      return res.status(202).json({ status: "idle", responder: "agent", messages: reply.messages, quote: reply.quote });
    }
    if (action === "close" && req.method === "POST") {
      return res.status(200).json({ status: "closed", responder: "agent" });
    }
    throw new PapError(404, "not_found", "Unknown conversation request");
  } catch (err) {
    sendError(res, err, { challenge: true });
  }
}

// What AISA gets about each message: who wrote it. "human" only when the text is the User's own words (spec 7.8).
function papData(message) {
  return { sender: message.sender === "human" ? "human" : "agent", message_id: message.id ? String(message.id) : undefined };
}

function mergeQuote(a, b) {
  return { status: b.status || a.status || null, fields: [].concat(a.fields || [], b.fields || []), removed: [].concat(a.removed || [], b.removed || []) };
}
