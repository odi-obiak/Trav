// PAP revocation endpoint. Session Tokens here are self-contained and short-lived, so revoking only acknowledges.
// DEMO NOTE: production keeps a revocation list in the session store.
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(req.method === "POST" ? 200 : 405).end();
}
