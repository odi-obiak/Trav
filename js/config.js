// Endpoint URLs for the build flow (Forward Deployed Demo, project AISA FDE - Auto). Leave a value empty to show that channel as "not connected".
export const CONFIG = {
  // Webchat v3 Config URL (Endpoint > Embedding HTML), e.g. https://endpoint-insuramatch.cognigy.cloud/<token>
  webchatConfigUrl: "https://endpoint-insuramatch.cognigy.cloud/9ae9d45fb8ae41e48170d34bef1da1d5568f75a8f42a326cda18264f019c7c4b",

  // Voice Gateway endpoint URL for Click To Call (https, no /voiceGateway suffix)
  voiceEndpointUrl: "https://endpoint-insuramatch.cognigy.cloud/856b53187dc93c28683df6f5ca8b8cea42ea3caa5864fedaf8c20730bedc5218",

  // Client libraries, pinned to exact versions (ES modules from jsDelivr).
  // DEMO SHORTCUT: served from a public CDN. Production self-hosts these files with Subresource Integrity.
  socketClientModuleUrl: "https://cdn.jsdelivr.net/npm/@cognigy/socket-client@4.9.2/+esm",
  clickToCallModuleUrl: "https://cdn.jsdelivr.net/npm/@cognigy/click-to-call-sdk@0.2.0/+esm",

  // STUN/TURN for restrictive networks (venue wifi). Empty uses the SDK defaults. Never commit TURN credentials here.
  iceServers: [],

  // PLACEHOLDER: final offer id and campaign come from Dave's storyline.
  defaultOffer: { offerId: "SLM-AUTO-OFFER-PLACEHOLDER", campaign: "slm-2026-demo", source: "marketing-email" },

  // Hosts allowed to render inside the "Shared by AISA" xApp frame in the quote panel.
  allowedXappHostSuffixes: [".cognigy.cloud", ".cognigy.ai"],

  // On-screen awareness: tell AISA which panel step, card and upload status the customer is looking at (screen.js).
  screenAwareness: true,

  firstChatMessage: "I'd like to start an auto quote",
  uploadText: "I'd like to share a document",
  liveAgentText: "I'd like to talk to a person",
};
