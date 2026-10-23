// PAP conversations (spec section 7): the personal agent talks to AISA (the Company Agent) for its User.
//   POST /api/pap/conversations                 start, with the first message                       201
//   POST /api/pap/conversations/{id}/messages   another message                                     202
//   GET  /api/pap/conversations/{id}/events     read events after a cursor
//   POST /api/pap/conversations/{id}/handoff    ask for a person                                    202
//   POST /api/pap/conversations/{id}/close      end it                                              200
// Both POSTs take ?wait (and ?cursor) to return AISA's reply in the same response, as a read of the events (7.3). AISA
// answers synchronously, so the reply is always there by the time the response goes out.
// vercel.json rewrites the paths to ?id=&action=.
import { authenticate, newConversation, ownedConversation, callAisa, sendError, bodyOf, origin, newId, ID, PapError } from "../../pap/lib.js";
import { conversation, acceptedMessage, rememberMessage } from "../../pap/store.js";
import { createHash } from "node:crypto";

export default async function handler(req, res) {
  const id = req.query.id ? String(req.query.id) : "";
  const action = req.query.action ? String(req.query.action) : "";
  const htu = `${origin(req)}/api/pap/conversations${id ? "/" + id : ""}${action ? "/" + action : ""}`;
  try {
    const session = await authenticate(req, htu);
    res.setHeader("Cache-Control", "no-store");
    // 7.5: `wait` is a whole number of seconds; `cursor` is an event id.
    const wait = req.query.wait;
    if (wait !== undefined && !/^\d+$/.test(String(wait))) throw new PapError(400, "invalid_request", "wait must be a whole number of seconds");
    const cursor = req.query.cursor !== undefined ? String(req.query.cursor) : undefined;
    const owner = `${session.client_id}|${session.sub}`;

    if (!id) {
      if (req.method !== "POST") throw new PapError(405, "invalid_request", "POST to start a conversation");
      const body = bodyOf(req);
      // 7.10. DEMO SHORTCUT: this prototype doesn't offer Direct Conversations.
      if (body.parent_conversation_id !== undefined) throw new PapError(400, "invalid_request", "Direct Conversations aren't offered by this prototype");
      const message = checkMessage(body.message);
      const retried = retry(owner, message);
      if (retried) return res.status(retried.status).json(retried.body);
      const { conversationId, quoteId } = newConversation(session);
      const conv = conversation(conversationId, true);
      // AISA is told who it's talking to: a personal agent this gateway verified, acting for a signed-out User. No `ui`,
      // so AISA takes its no-page path (options in words, no buttons). Its welcome is part of the conversation.
      const welcome = await callAisa(quoteId, "", { aisa_entry: { quoteId, actor: "agent", agent: { client_id: session.client_id, name: session.client_name }, signedIn: false } });
      record(conv, messageEvent(message, "user"));
      conv.context = { ...conv.context, ...(message.context || {}) };
      const reply = await callAisa(quoteId, message.text, { pap: papData(message, conv) });
      addCompanyMessage(conv, welcome);
      addCompanyMessage(conv, reply);
      afterAisa(conv, reply);
      const out = { status: 201, body: wait !== undefined ? read(conversationId, conv, cursor) : summary(conversationId, conv) };
      rememberMessage(`${owner}|${message.id}`, { hash: hashOf(message), conversationId, ...out });
      return res.status(out.status).json(out.body);
    }

    const { quoteId } = ownedConversation(session, id);
    // DEMO SHORTCUT: after a cold start the events are gone (see pap/store.js); the conversation still works.
    const conv = conversation(id, req.method === "POST" && action !== "close");

    if (action === "events" && req.method === "GET") {
      if (!conv) {
        if (cursor) throw new PapError(410, "cursor_expired", "The events at this cursor are no longer kept");
        return res.status(200).json({ conversation_id: id, events: [], cursor: null, has_more: false, status: "idle", responder: "agent" });
      }
      return res.status(200).json(read(id, conv, cursor));
    }

    if (action === "messages" && req.method === "POST") {
      if (conv.closed) throw new PapError(409, "conversation_closed", "This conversation takes no more messages");
      const message = checkMessage(bodyOf(req).message);
      const retried = retry(owner, message);
      if (retried) return res.status(retried.status).json(retried.body);
      record(conv, messageEvent(message, "user"));
      conv.context = { ...conv.context, ...(message.context || {}) };
      // A message with only `context` updates it without saying anything (7.4), so AISA isn't asked to reply.
      if (message.text || message.data) {
        const reply = await callAisa(quoteId, message.text || JSON.stringify(message.data), { pap: papData(message, conv) });
        addCompanyMessage(conv, reply);
        afterAisa(conv, reply);
      }
      const out = { status: 202, body: wait !== undefined ? read(id, conv, cursor) : summary(id, conv) };
      rememberMessage(`${owner}|${message.id}`, { hash: hashOf(message), conversationId: id, ...out });
      return res.status(out.status).json(out.body);
    }

    if (action === "handoff" && req.method === "POST") {
      if (conv.closed) throw new PapError(409, "conversation_closed", "This conversation is closed");
      // Already waiting for a person, or with one: nothing changes.
      if (conv.status === "queued" || conv.responder === "human") return res.status(202).json(summary(id, conv));
      setState(conv, "queued", "agent");
      // AISA's "Talk to a person" path. Transfers are off in this build, so no one joins: the status goes back to idle
      // and the Company Agent says why (7.9). DEMO SHORTCUT: production transfers to a licensed advisor.
      const reply = await callAisa(quoteId, "", { aisa_action: "live_agent", pap: { sender: "agent" } });
      addCompanyMessage(conv, reply);
      noOneAvailable(conv);
      return res.status(202).json(summary(id, conv));
    }

    if (action === "close" && req.method === "POST") {
      const closing = conv || conversation(id, true);
      if (!closing.closed) {
        closing.closed = true;
        setState(closing, "closed", closing.responder);
      }
      return res.status(200).json(summary(id, closing));
    }
    throw new PapError(404, "not_found", "Unknown conversation request");
  } catch (err) {
    sendError(res, err, { resource: true });
  }
}

// 7.4: a message has an id from the agent, a sender, and at least one of text, data or context. `role` is ours to set.
function checkMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new PapError(400, "invalid_request", "The body needs a message object");
  if (typeof message.id !== "string" || !ID.test(message.id)) throw new PapError(400, "invalid_request", "message.id must be 1 to 256 URL-safe base64 characters");
  if (message.sender !== "agent" && message.sender !== "human") throw new PapError(400, "invalid_request", "message.sender must be agent or human");
  const has = (key) => message[key] !== undefined && message[key] !== null && message[key] !== "";
  if (!has("text") && !has("data") && !has("context")) throw new PapError(400, "invalid_request", "A message needs text, data or context");
  if (has("data") && (typeof message.data !== "object" || Array.isArray(message.data))) throw new PapError(400, "invalid_request", "message.data must be a JSON object");
  if (has("context") && (typeof message.context !== "object" || Array.isArray(message.context))) throw new PapError(400, "invalid_request", "message.context must be a JSON object");
  const out = { id: message.id, sender: message.sender };
  for (const key of ["text", "data", "context"]) if (has(key)) out[key] = key === "text" ? String(message.text).slice(0, 4000) : message[key];
  return out;
}

// 7.3: message ids are unique for the User. The same id with the same content returns the original response; with
// different content, message_id_conflict.
const hashOf = (message) => createHash("sha256").update(JSON.stringify([message.sender, message.text || null, message.data || null, message.context || null])).digest("base64url");
function retry(owner, message) {
  const earlier = acceptedMessage(`${owner}|${message.id}`);
  if (!earlier) return null;
  if (earlier.hash !== hashOf(message)) throw new PapError(409, "message_id_conflict", "This message id was already used with different content");
  return earlier;
}

// What AISA gets about each message: who wrote it ("human" only for the User's own words, 7.8) and the User's context.
function papData(message, conv) {
  return { sender: message.sender, message_id: message.id, ...(Object.keys(conv.context).length ? { context: conv.context } : {}) };
}

const at = () => new Date().toISOString();
function record(conv, event) { conv.events.push(event); return event; }
const messageEvent = (message, role) => ({ id: newId("evt_"), type: "message", created_at: at(), message: { ...message, role } });

// AISA's reply as a Company message (7.4: id, role, sender, text, data). The quote rows go in `data`.
function addCompanyMessage(conv, reply) {
  if (!reply.text && !reply.quote.fields.length && !reply.quote.removed.length) return;
  const message = { id: newId("msg_"), sender: "agent" };
  if (reply.text) message.text = reply.text;
  if (reply.quote.fields.length || reply.quote.removed.length || reply.quote.status) message.data = { quote: reply.quote };
  record(conv, messageEvent(message, "company"));
}

// 7.7: every change to status or responder adds a state event with both.
function setState(conv, status, responder) {
  if (conv.status === status && conv.responder === responder) return;
  conv.status = status; conv.responder = responder;
  record(conv, { id: newId("evt_"), type: "state", created_at: at(), status, responder });
}

// AISA can hand off on its own (a 7A route-out). Same as a handoff request: queued, then no one available.
function afterAisa(conv, reply) {
  if (reply.quote.status === "advisor_requested" && conv.status !== "queued") {
    setState(conv, "queued", "agent");
    noOneAvailable(conv);
  }
}
function noOneAvailable(conv) {
  setState(conv, "idle", "agent");
  record(conv, messageEvent({ id: newId("msg_"), sender: "agent", text: "No advisor is available in this prototype, so the conversation stays with AISA." }, "company"));
}

// 7.3: the short answer to a POST without `wait`.
const summary = (conversationId, conv) => ({ conversation_id: conversationId, status: conv.status, responder: conv.responder });

// 7.5: a read. Events after the cursor (all of them without one); `cursor` is the last event returned, or the request's.
function read(conversationId, conv, cursor) {
  let events = conv.events;
  if (cursor !== undefined) {
    const index = conv.events.findIndex((event) => event.id === cursor);
    if (index < 0) throw new PapError(400, "invalid_cursor", "The cursor is unknown or doesn't belong to this conversation");
    events = conv.events.slice(index + 1);
  }
  return { conversation_id: conversationId, events, cursor: events.length ? events[events.length - 1].id : (cursor || null), has_more: false, status: conv.status, responder: conv.responder };
}
