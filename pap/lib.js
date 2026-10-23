// Personal Agent Protocol (PAP, draft 0.2), the company side, shared by the functions in api/pap/.
// This stands in for travelers.com: it lets a personal agent find AISA, prove who it is, and talk to AISA for its user.
// Section numbers below are the spec's (https://personalagentprotocol.org/docs/0.2/spec).
// DEMO SHORTCUT: a prototype gateway. Production uses Travelers' identity provider and API gateway (see PERSONAL_AGENTS.md).
//
// Settings (Vercel env vars, never in the repo):
//   PAP_ORIGIN            public origin of this site, e.g. https://trav.example.app (used for issuer and DPoP htu checks)
//   PAP_TOKEN_SECRET      secret that encrypts Session Tokens and signs session and conversation ids (32+ random characters)
//   PAP_ALLOWED_CLIENTS   comma-separated client_id URLs of personal agents allowed in (the allowlist)
//   AISA_REST_URL         Cognigy REST endpoint URL of "AISA Auto Quote (SLM) PA" (its token is a secret)
import { createHmac, createHash, randomBytes } from "node:crypto";
import { jwtVerify, EncryptJWT, jwtDecrypt, EmbeddedJWK, createRemoteJWKSet, calculateJwkThumbprint, decodeJwt, decodeProtectedHeader } from "jose";
import { firstUse } from "./store.js";

export const PROTOCOL_VERSION = "0.2";
const SESSION_HOURS = 2;          // 4.2: Session Tokens "SHOULD last hours, not days".
const PROOF_WINDOW_S = 120;       // 4.3: how old a DPoP proof may be (the acceptance window).
const ASSERTION_MAX_LIFE_S = 300; // 4.2: `exp` at most five minutes after `iat`.
export const ID = /^[A-Za-z0-9_-]{1,256}$/; // 7.2: conversation, message and event ids
export const newId = (prefix) => prefix + randomBytes(16).toString("base64url"); // 128 random bits

export function origin(req) {
  return (process.env.PAP_ORIGIN || `https://${req.headers.host}`).replace(/\/$/, "");
}
export const issuerOf = (req) => origin(req);

function secret() {
  const value = process.env.PAP_TOKEN_SECRET || "";
  if (value.length < 32) throw new PapError(500, "server_error", "PAP_TOKEN_SECRET is not set");
  return value;
}
const tokenKey = () => createHash("sha256").update("session-token|" + secret()).digest(); // 32 bytes for A256GCM
const hmac = (text) => createHmac("sha256", secret()).update(text).digest("base64url").slice(0, 22);

export class PapError extends Error {
  constructor(status, code, description, extra = {}) { super(description); this.status = status; this.code = code; this.extra = extra; }
}

// Token errors at the conversation endpoint go in WWW-Authenticate (section 6, 4.3); everything else is a JSON body
// with an `error` code (4.2 at the token endpoint, 7.13 at conversations).
const TOKEN_ERRORS = ["invalid_token", "invalid_dpop_proof", "use_dpop_nonce", "sign_in_required", "insufficient_scope"];
export function sendError(res, err, { resource = false } = {}) {
  const status = err instanceof PapError ? err.status : 500;
  const code = err instanceof PapError ? err.code : "server_error";
  if (!(err instanceof PapError)) console.error("pap: unexpected error", err && err.message); // never the request body or tokens
  if (resource && TOKEN_ERRORS.includes(code)) res.setHeader("WWW-Authenticate", `DPoP error="${code}", error_description="${String(err.message).replace(/"/g, "'")}", algs="ES256"`);
  if (status === 429) res.setHeader("Retry-After", "5");
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json({ error: code, error_description: err.message, ...((err && err.extra) || {}) });
}

const sha256url = (text) => createHash("sha256").update(text).digest("base64url");

// 4.3: a DPoP proof is checked as RFC 9449 4.3 says. At the token endpoint a failure is an OAuth error (HTTP 400);
// at the conversation endpoint it is HTTP 401 with WWW-Authenticate.
export async function verifyDpop(req, { htu, accessToken, boundJkt, atToken = false } = {}) {
  const fail = (description) => new PapError(atToken ? 400 : 401, "invalid_dpop_proof", description);
  const proof = req.headers.dpop;
  if (!proof || Array.isArray(proof) || String(proof).includes(",")) throw fail("Exactly one DPoP proof header is required");
  let header;
  try { header = decodeProtectedHeader(proof); } catch { throw fail("The DPoP proof is not a JWT"); }
  if (!header.jwk || ["d", "p", "q", "dp", "dq", "qi", "k"].some((member) => member in header.jwk)) throw fail("The DPoP proof's jwk must hold only a public key");
  let payload;
  try {
    ({ payload } = await jwtVerify(proof, EmbeddedJWK, { typ: "dpop+jwt", algorithms: ["ES256"] }));
  } catch { throw fail("The DPoP proof's signature, typ or alg is not valid"); }
  if (payload.htm !== req.method) throw fail("DPoP htm does not match the request");
  if (String(payload.htu || "").split(/[?#]/)[0] !== htu) throw fail("DPoP htu does not match the request URL");
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.iat !== "number" || Math.abs(now - payload.iat) > PROOF_WINDOW_S) throw fail("DPoP proof is outside the acceptance window");
  if (typeof payload.jti !== "string" || !payload.jti) throw fail("DPoP proof has no jti");
  if (accessToken !== undefined && payload.ath !== sha256url(accessToken)) throw fail("DPoP ath does not match the Session Token");
  const jkt = await calculateJwkThumbprint(header.jwk);
  if (boundJkt && jkt !== boundJkt) throw fail("The Session Token is bound to a different key");
  // 4.3: the token endpoint MUST reject a reused proof; elsewhere it's allowed, so it's done here too.
  if (!firstUse(`dpop|${jkt}|${payload.jti}`, PROOF_WINDOW_S * 2)) throw fail("This DPoP proof was already used");
  return { jkt };
}

// 3, 4.1: every URL the agent gives must be HTTPS and must not point inside our network.
// DEMO SHORTCUT: checks the host name only; production also checks the address it resolves to.
function publicHttps(value) {
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^(fc|fd|fe80)/.test(host)) return null;
  const ip = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return null;
  }
  return url;
}

// 4.1: the personal agent's client_id is an HTTPS URL whose document names its keys (jwks_uri). Fetched without
// following redirects; keys come only from jwks_uri, on the same domain.
const keySets = new Map(); // a cache per server instance, not storage
async function clientKeys(clientId) {
  const allowed = String(process.env.PAP_ALLOWED_CLIENTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  // DEMO SHORTCUT: an allowlist in an env var. Production: the registration or allowlist policy from the design.
  if (!allowed.includes(clientId)) throw new PapError(401, "invalid_client", "This personal agent is not registered");
  if (keySets.has(clientId)) return keySets.get(clientId);
  const url = publicHttps(clientId);
  if (!url) throw new PapError(401, "invalid_client", "client_id must be a public HTTPS URL");
  const response = await fetch(clientId, { redirect: "manual", signal: AbortSignal.timeout(5000), headers: { Accept: "application/json" } });
  if (response.status !== 200) throw new PapError(401, "invalid_client", "Could not read the client_id document");
  const doc = await response.json();
  if (doc.client_id !== clientId) throw new PapError(401, "invalid_client", "client_id document does not name itself");
  if (doc.token_endpoint_auth_method && doc.token_endpoint_auth_method !== "private_key_jwt") throw new PapError(401, "invalid_client", "token_endpoint_auth_method must be private_key_jwt");
  const sameDomain = (value) => { const other = publicHttps(value); return !!other && other.hostname === url.hostname; };
  if (!sameDomain(doc.jwks_uri)) throw new PapError(401, "invalid_client", "jwks_uri must be HTTPS on the client_id domain");
  if ((doc.redirect_uris || []).some((uri) => !sameDomain(uri))) throw new PapError(401, "invalid_client", "redirect_uris must be HTTPS on the client_id domain");
  const entry = { keys: createRemoteJWKSet(new URL(doc.jwks_uri), { timeoutDuration: 5000 }), name: String(doc.client_name || url.host) };
  keySets.set(clientId, entry);
  return entry;
}

// 4.1, 4.2: both assertions are short-lived, name the issuer as a single-string `aud`, and have a jti seen only once.
async function checkAssertion(jwt, keys, { clientId, issuer, subject, error }) {
  let payload;
  try {
    ({ payload } = await jwtVerify(jwt, keys, { issuer: clientId, algorithms: ["ES256", "RS256"], ...(subject ? { subject } : {}) }));
  } catch { throw new PapError(error === "invalid_client" ? 401 : 400, error, "The assertion's signature, iss or lifetime is not valid"); }
  if (typeof payload.aud !== "string" || payload.aud !== issuer) throw new PapError(error === "invalid_client" ? 401 : 400, error, "The assertion's aud must be the issuer, as a single string");
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number" || payload.exp - payload.iat > ASSERTION_MAX_LIFE_S) throw new PapError(error === "invalid_client" ? 401 : 400, error, "The assertion must expire within five minutes of iat");
  if (typeof payload.jti !== "string" || payload.jti.length < 16) throw new PapError(error === "invalid_client" ? 401 : 400, error, "The assertion needs a random jti");
  if (!firstUse(`assertion|${clientId}|${payload.jti}`, ASSERTION_MAX_LIFE_S)) throw new PapError(error === "invalid_client" ? 401 : 400, error, "This assertion was already used");
  return payload;
}

// 4.2: start a signed-out Session (or renew one, with session_id). Section 7.11: a new auto quote needs no account.
export async function startSession(req, form) {
  const issuer = issuerOf(req);
  if (form.grant_type !== "urn:ietf:params:oauth:grant-type:jwt-bearer") throw new PapError(400, "unsupported_grant_type", "Use the JWT bearer grant");
  if (form.client_assertion_type !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" || !form.client_assertion || !form.assertion) {
    throw new PapError(400, "invalid_request", "client_assertion and assertion are required");
  }
  let clientId;
  try { clientId = String(decodeJwt(form.client_assertion).iss || ""); } catch { throw new PapError(401, "invalid_client", "client_assertion is not a JWT"); }
  if (!clientId || (form.client_id && form.client_id !== clientId)) throw new PapError(401, "invalid_client", "client_id does not match the client assertion");
  const client = await clientKeys(clientId);
  await checkAssertion(form.client_assertion, client.keys, { clientId, issuer, subject: clientId, error: "invalid_client" });
  const user = await checkAssertion(form.assertion, client.keys, { clientId, issuer, error: "invalid_grant" });
  if (!user.sub) throw new PapError(400, "invalid_grant", "The assertion must name the User in sub");
  const { jkt } = await verifyDpop(req, { htu: `${issuer}/api/pap/token`, atToken: true });
  // Session ids are signed for this agent and User, so a renewal can be checked without storing sessions.
  let sid = randomBytes(12).toString("base64url");
  if (form.session_id) {
    const match = String(form.session_id).match(/^ses_([A-Za-z0-9_-]{16})([A-Za-z0-9_-]{22})$/);
    if (!match || match[2] !== hmac(`session|${match[1]}|${clientId}|${user.sub}`)) throw new PapError(400, "invalid_session", "The Session has ended, or belongs to another agent or User");
    sid = match[1];
  }
  const sessionId = `ses_${sid}${hmac(`session|${sid}|${clientId}|${user.sub}`)}`;
  // 4.2 Token format: opaque to the agent. It's encrypted, so the agent can't read or depend on what's inside.
  const accessToken = await new EncryptJWT({ client_id: clientId, client_name: client.name, sid: sessionId, scope: "", signed_in: false, cnf: { jkt } })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" }).setIssuer(issuer).setAudience(issuer).setSubject(String(user.sub))
    .setIssuedAt().setExpirationTime(`${SESSION_HOURS}h`).encrypt(tokenKey());
  return { access_token: accessToken, token_type: "DPoP", expires_in: SESSION_HOURS * 3600, scope: "", session_id: sessionId, signed_in: false };
}

// 4.3: every conversation request carries "Authorization: DPoP <token>" and a proof for this URL, bound to the token's key.
// A token in the URL is never read, and the Bearer scheme is refused.
export async function authenticate(req, htu) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^DPoP\s+(\S+)$/);
  if (!match) throw new PapError(401, "invalid_token", "Send the Session Token as Authorization: DPoP (Bearer isn't accepted here)");
  let session;
  try {
    ({ payload: session } = await jwtDecrypt(match[1], tokenKey(), { issuer: issuerOf(req), audience: issuerOf(req) }));
  } catch { throw new PapError(401, "invalid_token", "The Session Token is not valid or has expired"); }
  await verifyDpop(req, { htu, accessToken: match[1], boundJkt: session.cnf && session.cnf.jkt });
  return session;
}

// 7.2: a conversation belongs to the agent's client_id and the User. Its id carries a signature for both, so a request
// from anyone else gets conversation_not_found. The quote id inside it is AISA's Contact Profile key (aisa-<quoteId>),
// chosen here, never by the agent.
export function newConversation(session) {
  const hex = randomBytes(8).toString("hex");
  return { conversationId: `cnv_${hex}${hmac(`conv|${hex}|${session.client_id}|${session.sub}`)}`, quoteId: "PA-" + hex };
}
export function ownedConversation(session, conversationId) {
  const match = String(conversationId || "").match(/^cnv_([0-9a-f]{16})([A-Za-z0-9_-]{22})$/);
  if (!match || match[2] !== hmac(`conv|${match[1]}|${session.client_id}|${session.sub}`)) throw new PapError(404, "conversation_not_found", "No such conversation for this agent and User");
  return { quoteId: "PA-" + match[1] };
}

// AISA over the Cognigy REST endpoint. Returns AISA's reply as one text (a streamed reply arrives in pieces), and the
// quote rows it saved, which go to the agent in the message's `data` (7.4: structured details belong in data).
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
  return fromAisa(await response.json());
}

export function fromAisa(result) {
  const outputs = Array.isArray(result && result.outputStack) ? result.outputStack : [];
  let text = "";
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
    const piece = String(output && output.text || "").trim();
    if (piece) text += text ? (/[\n:]$/.test(text) ? "\n" : " ") + piece : piece;
  }
  return { text, quote };
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
