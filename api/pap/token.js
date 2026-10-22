// PAP token endpoint: a personal agent proves who it is and gets a signed-out Session Token bound to its DPoP key.
import { startSession, sendError, bodyOf, PapError } from "../../pap/lib.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") throw new PapError(405, "invalid_request", "POST only");
    const result = await startSession(req, bodyOf(req));
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(result);
  } catch (err) {
    sendError(res, err);
  }
}
