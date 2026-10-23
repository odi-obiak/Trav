// What the PAP gateway has to remember between requests: seen jti values (the token endpoint MUST reject a reused
// assertion or proof), each conversation's events, its status, whether it's closed, and accepted message ids (a retried
// message returns the original response).
// DEMO SHORTCUT: kept in the memory of one server instance. Vercel reuses a warm instance, so with prototype traffic this
// holds, but a cold start forgets it: old cursors then get cursor_expired, and a replay sent to a second instance isn't
// caught. Production keeps all of this in a store shared by every server, with conversations kept 30 days or more.

const seen = new Map();          // key -> expiry time (ms)
const conversations = new Map(); // conversation id -> { events, status, responder, closed, context }
const messages = new Map();      // "<client_id>|<user id>|<message id>" -> { hash, status, body, conversationId }

function prune(map, now) {
  if (map.size < 5000) return;
  for (const [key, value] of map) if ((value.expires || value) < now) map.delete(key);
}

// true the first time a key is seen within its lifetime, false for a replay.
export function firstUse(key, lifetimeSeconds) {
  const now = Date.now();
  prune(seen, now);
  const until = seen.get(key);
  if (until && until > now) return false;
  seen.set(key, now + lifetimeSeconds * 1000);
  return true;
}

export function conversation(id, create = false) {
  if (!conversations.has(id) && create) conversations.set(id, { events: [], status: "idle", responder: "agent", closed: false, context: {}, expires: Date.now() + 30 * 864e5 });
  return conversations.get(id) || null;
}

export const acceptedMessage = (key) => messages.get(key) || null;
export function rememberMessage(key, entry) {
  prune(messages, Date.now());
  messages.set(key, { ...entry, expires: Date.now() + 30 * 864e5 });
}
