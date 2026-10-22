// Serves /.well-known/poppy.json and /.well-known/oauth-authorization-server (see vercel.json rewrites).
// A function, not a static file, so the domain and issuer follow PAP_ORIGIN on any deployment.
import { origin, PROTOCOL_VERSION } from "../../pap/lib.js";

export default function handler(req, res) {
  const base = origin(req);
  const host = new URL(base).host;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, max-age=300");
  if (req.query.doc === "oauth") {
    return res.status(200).json({
      issuer: base,
      token_endpoint: `${base}/api/pap/token`,
      revocation_endpoint: `${base}/api/pap/revoke`,
      grant_types_supported: ["urn:ietf:params:oauth:grant-type:jwt-bearer"],
      token_endpoint_auth_methods_supported: ["private_key_jwt"],
      dpop_signing_alg_values_supported: ["ES256"],
      poppy_domains: [host],
    });
  }
  // Signed-out Sessions only: a new auto quote has no account yet, so no sign-in types are offered.
  return res.status(200).json({
    protocol_version: PROTOCOL_VERSION,
    organization: { name: "Travelers (AISA prototype)", domain: host },
    auth: { issuer: base },
    agent: { protocols: [{ type: "poppy", endpoint: `${base}/api/pap/conversations` }] },
  });
}
