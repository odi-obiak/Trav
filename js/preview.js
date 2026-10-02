// PLACEHOLDER conversation for ?preview=1, so the layout can be reviewed without a live flow.
// Names, vehicles, dates and the claim are invented; AISA's wording is illustrative, not approved copy.
// It walks the story beats: name and address, dec page extraction, a vehicle added mid-conversation (Step 5),
// a switch to voice (Step 7), drivers, and one glass claim (Step 6).
export const PREVIEW_SCRIPT = [
  {
    bot: "Hi, I'm AISA, Travelers' AI assistant. I'll put your auto quote together with you. If you have your current declaration page, you can upload it and I'll only ask what's missing. First, what's your full name?",
    choices: [{ title: "Upload my declaration page", payload: "upload" }],
    ui: { section: "client", progress: { done: 0, total: 24 } },
  },
  { user: "Alex Smith", wait: 1400 },
  {
    ui: { fields: [
      { key: "client.firstName", label: "First Name", value: "Alex", source: "customer" },
      { key: "client.lastName", label: "Last Name", value: "Smith", source: "customer" },
    ] },
    bot: "Thanks, Alex. What's your home address?",
  },
  { user: "48 Maple Ave, Hartford, Connecticut 06105", wait: 1600 },
  {
    ui: { fields: [
      { key: "client.address", label: "Street Address", value: "48 Maple Ave", source: "customer" },
      { key: "client.city", label: "City", value: "Hartford", source: "customer" },
      { key: "client.state", label: "State", value: "CT", source: "customer" },
      { key: "client.zip", label: "ZIP", value: "06105", source: "customer", confirmed: false },
    ] },
    bot: "Got it, I've put that in your quote on the right so you can check it. Do you have your declaration page handy?",
  },
  { user: "Yes, here's a photo of it.", wait: 1400 },
  { note: "Declaration page received (photo). Reading it now." },
  {
    wait: 2200,
    ui: {
      section: "vehicles",
      progress: { done: 11, total: 24 },
      fields: [
        { key: "vehicle[0].year", label: "Year", value: "2021", source: "extracted" },
        { key: "vehicle[0].make", label: "Make", value: "Ford", source: "extracted" },
        { key: "vehicle[0].model", label: "Model", value: "Escape", source: "extracted" },
        { key: "vehicle[0].bodyStyle", label: "Body Style", value: "4D SUV", source: "prefilled" },
        { key: "driver[0].firstName", label: "First Name", value: "Alex", source: "extracted" },
        { key: "driver[0].lastName", label: "Last Name", value: "Smith", source: "extracted" },
        { key: "driver[1].firstName", label: "First Name", value: "Jane", source: "extracted" },
        { key: "driver[1].lastName", label: "Last Name", value: "Smith", source: "extracted" },
        { key: "driver[1].relationship", label: "Relationship to You", value: "Spouse", source: "extracted" },
        { key: "policy.currentlyInsured", label: "Do you currently have auto insurance?", value: "Yes", source: "extracted" },
        { key: "policy.priorCarrier", label: "Current Auto Insurance Company", value: "Example Mutual", source: "extracted" },
      ],
      // PLACEHOLDER counts and wording (real ones come from the flow's rules.copy).
      efficiency: { total: 31, asked: 6, filled: 11, fromDoc: 9, fromRecords: 1, fromAnswers: 1, chip: "11 filled for you",
        line: "AISA filled in 11 of 31 answers, so you only answered 6.", detail: "9 from your declaration page, 1 from records, 1 reused from your earlier answers." },
    },
    bot: "Thanks. Your declaration page shows a 2021 Ford Escape, with you and Jane Smith as drivers. I've filled those in, so I won't ask for them again.",
  },
  { user: "Oh, I also just bought a 2024 Toyota RAV4 last week. Can we add that?", wait: 1800 },
  {
    ui: { fields: [
      { key: "vehicle[1].year", label: "Year", value: "2024", source: "customer" },
      { key: "vehicle[1].make", label: "Make", value: "Toyota", source: "customer" },
      { key: "vehicle[1].model", label: "Model", value: "RAV4", source: "customer" },
    ] },
    bot: "Congratulations on the new RAV4. I've added it as your second vehicle. Is it owned, financed, or leased?",
    choices: [{ title: "Owned", payload: "Owned" }, { title: "Financed", payload: "Financed" }, { title: "Leased", payload: "Leased" }],
  },
  { channel: "voice", note: "Switched to voice. Everything so far is kept.", wait: 1600 },
  { user: "It's financed.", via: "voice", wait: 1600 },
  {
    via: "voice",
    ui: {
      section: "drivers",
      progress: { done: 15, total: 24 },
      fields: [{ key: "vehicle[1].ownership", label: "Is this vehicle owned or leased?", value: "Financed", source: "customer" }],
    },
    bot: "Thanks. Now your driver details: your license status, how old you were when first licensed, whether you need an SR-22, and which vehicle you drive most.",
  },
  { user: "Valid U.S. license, first licensed at sixteen, no SR-22, and I drive the Escape.", via: "voice", wait: 2000 },
  {
    via: "voice",
    ui: { fields: [
      { key: "driver[0].licenseStatus", label: "Current License Status", value: "Valid U.S. License", source: "customer" },
      { key: "driver[0].ageFirstLicensed", label: "Age first licensed in the U.S. or Canada?", value: "16", source: "customer" },
      { key: "driver[0].sr22", label: "Does this driver require an SR-22?", value: "No", source: "customer" },
      { key: "driver[0].primaryVehicle", label: "Which vehicle do you drive most often?", value: "2021 Ford Escape", source: "customer" },
    ] },
    bot: "Got it. Your declaration page lists Jane as your spouse. What's her date of birth, and does she need an SR-22?",
  },
  { user: "January 1st, 1981. No SR-22.", via: "voice", wait: 1800 },
  {
    via: "voice",
    ui: {
      section: "losses",
      progress: { done: 20, total: 24 },
      fields: [
        { key: "driver[1].dob", label: "Date of Birth", value: "01/01/1981", source: "customer" },
        { key: "driver[1].sr22", label: "Does this driver require an SR-22?", value: "No", source: "customer" },
      ],
    },
    bot: "Thanks. In the last few years, has anyone in the household had an accident, a ticket, or an insurance claim?",
  },
  { user: "Just a cracked windshield last spring. Glass claim, nobody was hurt.", via: "voice", wait: 2000 },
  {
    via: "voice",
    ui: { fields: [
      { key: "loss[0].type", label: "What happened?", value: "Other claim", source: "customer" },
      { key: "loss[0].description", label: "Description", value: "Windshield / glass", source: "customer" },
      { key: "loss[0].injuries", label: "Was anyone injured?", value: "No", source: "customer" },
    ] },
    bot: "Thanks for telling me, that one's easy. Roughly when did it happen?",
  },
  { user: "Actually, can I talk to a person about this?", via: "voice", wait: 1800 },
  {
    via: "voice",
    // PLACEHOLDER summary; the real one comes from the flow's handoff record.
    ui: { status: "advisor_requested", notice: "Simulated handoff: a licensed advisor would receive everything shown here.",
      advisorSummary: "Alex Smith started an auto quote from offer SLM-AUTO-OFFER-PLACEHOLDER and asked for a licensed advisor (reason: requested_human). Vehicles: 2021 Ford Escape (extracted); 2024 Toyota RAV4 (customer). Drivers: Alex Smith, Jane Smith. Loss history: Windshield / glass, injuries: none. AISA filled 11 of 31 answers without asking.",
      advisorRecord: { name: "Alex Smith", reason: "requested_human", words: "Can I talk to a person about this?", vehicles: ["2021 Ford Escape (extracted)", "2024 Toyota RAV4 (customer)"], drivers: ["Alex Smith", "Jane Smith"], losses: ["Windshield / glass, injuries: none"], lossNone: false, status: "rating", progress: { done: 31, total: 31 }, counts: { extracted: 11, customer: 20 }, efficiency: { filled: 11, total: 31 } } },
    bot: "Of course. A licensed advisor can help with that. I've shared everything so far, so you won't need to repeat anything.",
  },
];
