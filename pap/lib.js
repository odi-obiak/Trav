// Personal Agent Protocol (PAP, draft 0.2), the company side, shared by the functions in api/pap/.
// This stands in for travelers.com: it lets a personal agent find AISA, prove who it is, and talk to AISA for its user.
// DEMO SHORTCUT: a prototype gateway. Production uses Travelers' identity provider and API gateway (see PERSONAL_AGENTS.md).
//
// Settings (Vercel env vars, never in the repo):
//   PAP_ORIGIN            public origin of this site, e.g. https://trav.example.app (used for issuer and DPoP htu checks)
//   PAP_TOKEN_SECRET      secret that signs Session Tokens and conversation ids (32+ random characters)
//   PAP_ALLOWED_CLIENTS   comma-separated client_id URLs of personal agents allowed in (the allowlist)
//   AISA_REST_URL         Cognigy REST endpoint URL of "AISA Auto Quote (SLM) PA" (its token is a secret)
import { createHmac, createHash, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT, EmbeddedJWK, createRemoteJWKSet, calculateJwkThumbprint, decodeProtectedHeader } from "jose";

export const PROTOCOL_VERSION = "0.2";
const SESSION_HOURS = 2;          // The spec: Session Tokens "SHOULD last hours, not days".
const PROOF_MAX_AGE_S = 120;      // How old a DPoP proof may be.
const ASSERTION_MAX_LIFE_S = 300; // A session assertion may live at most five minutes.

export function origin(req) {
  return (process.env.PAP_ORIGIN || `https://${req.headers.host}`).replace(/\/$/, "");
}
export const issuerOf = (req) => origin(req);

function secret() {
  const value = process.env.PAP_TOKEN_SECRET || "";
  if (value.length < 32) throw new PapError(500, "server_error", "PAP_TOKEN_SECRET is not set");
  return new TextEncoder().encode(value);
}

export class PapError extends Error {
  constructor(status, code, description, headers = {}) { super(description); this.status = status; this.code = code; this.headers = headers; }
}

// Errors: OAuth-style JSON at the token endpoint, a WWW-Authenticate challenge at the conversation endpoint.
export function sendError(res, err, { challenge = false } = {}) {
  const status = err instanceof PapError ? err.status : 500;
  const code = err instanceof PapError ? err.code : "server_error";
  if (!(err instanceof PapError)) console.error("pap: unexpected error", err && err.message); // never the request body or tokens
  for (const [key, value] of Object.entries(err.headers || {})) res.setHeader(key, value);
  if (challenge && (status === 401 || status === 403)) res.setHeader("WWW-Authenticate", `DPoP error="${code}", algs="ES256"`);
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json({ error: code, error_description: err.message });
}

const sha256url = (text) => createHash("sha256").update(text).digest("base64url");

// DPoP proof (RFC 9449 4.3): signed by the key inside its own header, for this method and URL, recent, with a jti.
// At a resource, `ath` must be the hash of the access token, and the key must be the one the token is bound to.
// DEMO SHORTCUT: no replay cache for proof jti (needs a shared store). Production keeps one shared by all servers.
export async function verifyDpop(req, { htu, accessToken, boundJkt } = {}) {
  const proof = req.headers.dpop;
  if (!proof || Array.isArray(proof)) throw new PapError(400, "invalid_dpop_proof", "A single DPoP proof header is required");
  let payload, protectedHeader;
  try {
    ({ payload, protectedHeader } = await jwtVerify(proof, EmbeddedJWK, { typ: "dpop+jwt", algorithms: ["ES256"] }));
  } catch (e) {
    throw new PapError(400, "invalid_dpop_proof", "The DPoP proof is not valid");
  }
  if (payload.htm !== req.method) throw new PapError(400, "invalid_dpop_proof", "DPoP htm does not match the request");
  if (String(payload.htu || "").split(/[?#]/)[0] !== htu) throw new PapError(400, "invalid_dpop_proof", "DPoP htu does not match the request URL");
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.iat !== "number" || Math.abs(now - payload.iat) > PROOF_MAX_AGE_S) throw new PapError(400, "invalid_dpop_proof", "DPoP proof is too old or from the future");
  if (!payload.jti) throw new PapError(400, "invalid_dpop_proof", "DPoP proof has no jti");
  if (accessToken !== undefined && payload.ath !== sha256url(accessToken)) throw new PapError(401, "invalid_dpop_proof", "DPoP ath does not match the token");
  const jkt = await calculateJwkThumbprint(protectedHeader.jwk);
  if (boundJkt && jkt !== boundJkt) throw new PapError(401, "invalid_token", "The token is bound to a different key");
  return { jkt };
}

// The personal agent's identity: its client_id is an HTTPS URL whose document names its keys (jwks_uri).
// Fetched without following redirects, and keys only from jwks_uri on the same host.
const keySets = new Map(); // Per function instance only: a cache, not storage.
async function clientKeys(clientId) {
  const allowed = String(process.env.PAP_ALLOWED_CLIENTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  // DEMO SHORTCUT: an allowlist in an env var. Production: the registration or allowlist policy from the design.
  if (!allowed.includes(clientId)) throw new PapError(401, "invalid_client", "This personal agent is not registered");
  if (keySets.has(clientId)) return keySets.get(clientId);
  let url;
  try { url = new URL(clientId); } catch { throw new PapError(401, "invalid_client", "client_id is not a URL"); }
  if (url.protocol !== "https:") throw new PapError(401, "invalid_client", "client_id must be HTTPS");
  const response = await fetch(clientId, { redirect: "manual", signal: AbortSignal.timeout(5000), headers: { Accept: "application/json" } });
  if (response.status !== 200) throw new PapError(401, "invalid_client", "Could not read the client_id document");
  const doc = await response.json();
  if (doc.client_id !== clientId) throw new PapError(401, "invalid_client", "client_id document does not name itself");
  const jwksUri = new URL(String(doc.jwks_uri || ""), clientId);
  if (jwksUri.protocol !== "https:" || jwksUri.host !== url.host) throw new PapError(401, "invalid_client", "jwks_uri must be HTTPS on the client_id host");
  const entry = { keys: createRemoteJWKSet(jwksUri, { timeoutDuration: 5000 }), name: String(doc.client_name || url.host) };
  keySets.set(clientId, entry);
  return entry;
}

// Token endpoint: an RFC 7523 JWT bearer grant. client_assertion proves which agent; assertion names the User.
export async function startSession(req, form) {
  const issuer = issuerOf(req);
  if (form.grant_type !== "urn:ietf:params:oauth:grant-type:jwt-bearer") throw new PapError(400, "unsupported_grant_type", "Use the JWT bearer grant");
  if (form.client_assertion_type !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" || !form.client_assertion || !form.assertion) {
    throw new PapError(400, "invalid_request", "client_assertion and assertion are required");
  }
  let clientId;
  try { clientId = decodeIss(form.client_assertion); } catch { throw new PapError(401, "invalid_client", "client_assertion is not a JWT"); }
  const client = await clientKeys(clientId);
  try {
    await jwtVerify(form.client_assertion, client.keys, { issuer: clientId, subject: clientId, audience: issuer, algorithms: ["ES256"], maxTokenAge: ASSERTION_MAX_LIFE_S });
  } catch { throw new PapError(401, "invalid_client", "client_assertion is not valid"); }
  let user;
  try {
    ({ payload: user } = await jwtVerify(form.assertion, client.keys, { issuer: clientId, audience: issuer, algorithms: ["ES256"], maxTokenAge: ASSERTION_MAX_LIFE_S }));
  } catch { throw new PapError(400, "invalid_grant", "assertion is not valid"); }
  if (!user.sub || !user.jti || typeof user.exp !== "number" || user.exp - user.iat > ASSERTION_MAX_LIFE_S) throw new PapError(400, "invalid_grant", "assertion needs sub, jti and a short exp");
  // DEMO SHORTCUT: assertion jti and proof jti are not checked for reuse (needs a shared store).
  const { jkt } = await verifyDpop(req, { htu: `${issuer}/api/pap/token` });
  let sessionId = randomBytes(12).toString("base64url");
  if (form.session_id) {
    // Renewal: the old session must belong to this agent and User. Session ids are signed so nothing is stored.
    const [sid, tag] = String(form.session_id).split(".");
    if (!sid || tag !== hmac(`session|${sid}|${clientId}|${user.sub}`)) throw new PapError(400, "invalid_session", "Unknown session");
    sessionId = sid;
  }
  const sessionRef = `${sessionId}.${hmac(`session|${sessionId}|${clientId}|${user.sub}`)}`;
  const accessToken = await new SignJWT({ client_id: clientId, client_name: client.name, sid: sessionRef, scope: "", signed_in: false, cnf: { jkt } })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" }).setIssuer(issuer).setAudience(issuer).setSubject(String(user.sub))
    .setIssuedAt().setExpirationTime(`${SESSION_HOURS}h`).sign(secret());
  return { access_token: accessToken, token_type: "DPoP", expires_in: SESSION_HOURS * 3600, scope: "", session_id: sessionRef, signed_in: false };
}

function decodeIss(jwt) {
  decodeProtectedHeader(jwt);
  const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
  if (!payload.iss) throw new Error("no iss");
  return String(payload.iss);
}

// Every conversation request: "Authorization: DPoP <token>" plus a proof for this URL bound to the token's key.
export async function authenticate(req, htu) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^DPoP\s+(.+)$/i);
  if (!match) throw new PapError(401, "invalid_token", "Send the Session Token as Authorization: DPoP");
  let session;
  try {
    ({ payload: session } = await jwtVerify(match[1], secret(), { issuer: issuerOf(req), audience: issuerOf(req), typ: "at+jwt" }));
  } catch { throw new PapError(401, "invalid_token", "The Session Token is not valid or has expired"); }
  await verifyDpop(req, { htu, accessToken: match[1], boundJkt: session.cnf && session.cnf.jkt });
  return session;
}

const hmac = (text) => createHmac("sha256", secret()).update(text).digest("base64url").slice(0, 22);

// Conversation ids carry their own proof of ownership (agent + User), so nothing is stored.
// The quote id is the readable part; AISA's Contact Profile key is aisa-<quoteId>, chosen here, never by the client.
export function newConversation(session) {
  const quoteId = "PA-" + randomBytes(8).toString("hex");
  return { conversationId: `${quoteId}.${hmac(`conv|${quoteId}|${session.client_id}|${session.sub}`)}`, quoteId };
}
export function openConversation(session, conversationId) {
  const [quoteId, tag] = String(conversationId || "").split(".");
  if (!quoteId || tag !== hmac(`conv|${quoteId}|${session.client_id}|${session.sub}`)) throw new PapError(404, "conversation_not_found", "No such conversation for this agent and User");
  return { quoteId };
}

// AISA over the Cognigy REST endpoint. sessionId and userId both come from the quote id.
export async function callAisa(quoteId, text, data) {
  const url = process.env.AISA_REST_URL;
  if (!url) throw new PapError(503, "temporarily_unavailable", "AISA is not connected (AISA_REST_URL)");
  let response;
  try {
    response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(28000),
      body: JSON.stringify({ userId: `aisa-${quoteId}`, sessionId: `pa-${quoteId}`, text: text || "", data: data || {} }),
    });
  } catch { throw new PapError(504, "temporarily_unavailable", "AISA did not answer in time"); }
  if (!response.ok) throw new PapError(502, "temporarily_unavailable", `AISA returned ${response.status}`);
  return toCompanyMessages(await response.json());
}

// AISA's outputs become company messages. The quote panel's rows ride along in data.quote so the agent's
// user can see what was saved. Everything else in AISA's data (page-only payloads) stays here.
export function toCompanyMessages(result) {
  const outputs = Array.isArray(result && result.outputStack) ? result.outputStack : [];
  const messages = [];
  const quote = { status: null, fields: [], removed: [] };
  for (const output of outputs) {
    const ui = output && output.data && output.data.aisa_ui;
    if (ui && typeof ui === "object") {
      if (ui.status) quote.status = ui.status;
      for (const field of Array.isArray(ui.fields) ? ui.fields : []) {
        if (field && !field.open && field.value !== "" && field.value != null) quote.fields.push({ key: field.key, label: field.label, section: field.section, value: field.value, source: field.source });
      }
      if (Array.isArray(ui.removeKeys)) quote.removed.push(...ui.removeKeys);
    }
    const text = String(output && output.text || "").trim();
    if (text) {
      const last = messages[messages.length - 1];
      if (last) last.text += (/[\n:]$/.test(last.text) ? "\n" : " ") + text; // a streamed reply arrives in pieces
      else messages.push({ id: "m_" + randomBytes(6).toString("hex"), role: "company", sender: "agent", text });
    }
  }
  return { messages, quote };
}

// Vercel gives req.body parsed for JSON and form posts; keep a fallback for raw strings.
export function bodyOf(req) {
  const body = req.body;
  if (body && typeof body === "object") return body;
  if (typeof body === "string") {
    try { return JSON.parse(body); } catch { return Object.fromEntries(new URLSearchParams(body)); }
  }
  return {};
}
