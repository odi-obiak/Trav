// Quote steps and fields for the "Your quote" panel.
//
// Source of truth for labels, field types and options: Travelers' web channel question set
// ("AI Questions September 2026.xlsx", sheets named in `sheet`). Fields marked src: "wireframe" come from
// Jill Hanks' AISA wireframe and are not in that sheet yet. Keys follow the CLAUDE.md section 6B data model,
// so the flow and the page share one vocabulary.
//
// PLACEHOLDER: step order and the 7-step split follow the wireframe ("Step 3/7: Add Drivers"); confirm against
// the full wireframe set. State-specific questions (CA, DE, FL, MA, NC, NY, PA, VA, VT) are left out of the demo
// panel; the flow owns state logic.

const YES_NO = ["Yes", "No"];

export const STEPS = [
  {
    id: "client",
    title: "About You",
    prefix: "client",
    fields: [
      { key: "currentCustomer", label: "Are you currently a Travelers customer?", type: "radio", options: YES_NO, required: true, sheet: "autoStart" },
      { key: "firstName", label: "First Name", type: "text", required: true, maxLength: 20, sheet: "aboutyou" },
      { key: "middleInitial", label: "Middle Initial", type: "text", maxLength: 1, sheet: "aboutyou" },
      { key: "lastName", label: "Last Name", type: "text", required: true, maxLength: 25, sheet: "aboutyou" },
      { key: "suffix", label: "Suffix", type: "select", options: ["None", "Jr.", "Sr.", "II", "III", "IV"], sheet: "aboutyou" },
      { key: "address", label: "Street Address", type: "text", required: true, maxLength: 26, sheet: "aboutyou" },
      { key: "unit", label: "Unit #", type: "text", maxLength: 5, sheet: "aboutyou" },
      { key: "city", label: "City", type: "text", required: true, sheet: "aboutyou" },
      { key: "state", label: "State", type: "text", required: true, readOnly: true, sheet: "aboutyou" },
      { key: "zip", label: "ZIP", type: "tel", required: true, maxLength: 5, sheet: "aboutyou" },
      { key: "isMailingAddress", label: "Is this your mailing address?", type: "radio", options: YES_NO, required: true, sheet: "aboutyou" },
      { key: "movedLast6Months", label: "Have you moved in the last 6 months?", type: "radio", options: YES_NO, required: true, sheet: "aboutyou" },
      { key: "previousAddress", label: "Previous Residence Address", type: "text", required: true, maxLength: 26, sheet: "aboutyou",
        showIf: (v) => v("movedLast6Months") === "Yes" },
      { key: "gender", label: "Gender", type: "select", options: ["Male", "Female", "Non-Binary/Not-Specified"], required: true, sheet: "aboutyou" },
      { key: "email", label: "Email", type: "email", required: true, maxLength: 60, sheet: "aboutyou2" },
      { key: "phone", label: "Phone Number", type: "tel", maxLength: 14, sheet: "aboutyou2" },
    ],
  },
  {
    id: "vehicles",
    title: "Add Vehicles",
    prefix: "vehicle",
    entity: { noun: "vehicle", max: 2, name: (v) => [v("year"), v("make"), v("model")].filter(Boolean).join(" ") },
    fields: [
      { key: "year", label: "Year", type: "text", required: true, sheet: "vehicleDetails" },
      { key: "make", label: "Make", type: "text", required: true, sheet: "vehicleDetails" },
      { key: "model", label: "Model", type: "text", required: true, sheet: "vehicleDetails" },
      { key: "bodyStyle", label: "Body Style", type: "text", required: true, sheet: "vehicleDetails" },
      // PLACEHOLDER options: the sheet points at reference data (radRegistered, vehLeasedCd, usage) not included in it.
      { key: "registeredTo", label: "This vehicle is registered to", type: "text", required: true, sheet: "vehicleDetails" },
      { key: "ownership", label: "Is this vehicle owned or leased?", type: "text", required: true, sheet: "vehicleDetails" },
      { key: "usage", label: "How is this vehicle used?", type: "text", required: true, sheet: "vehicleDetails" },
      { key: "commuteMiles", label: "How many miles do you commute to work/school one way?", type: "tel", required: true, maxLength: 3, sheet: "vehicleDetails" },
      { key: "commuteDays", label: "How many days a week do you commute?", type: "select", options: ["1", "2", "3", "4", "5", "6", "7"], required: true, sheet: "vehicleDetails" },
      { key: "annualMiles", label: "How many miles is this vehicle driven each year?", type: "tel", required: true, maxLength: 6, sheet: "vehicleDetails" },
      { key: "garagingZip", label: "ZIP code where vehicle is kept", type: "tel", required: true, maxLength: 5, sheet: "vehicleDetails" },
      { key: "originalOwner", label: "Are you the original owner?", type: "radio", options: YES_NO, sheet: "vehicleDetails",
        showIf: (v) => v("ownership") === "Financed" || v("ownership") === "Leased" },
      { key: "loanLeaseGap", label: "Loan or lease gap coverage?", type: "select", options: ["Yes", "No", "Not sure"], sheet: "vehicleDetails",
        showIf: (v) => v("originalOwner") === "Yes" },
      { key: "collision", label: "Collision coverage?", type: "select", options: ["Yes", "No", "Not sure"], sheet: "vehicleDetails",
        showIf: (v) => v("ownership") !== "Financed" && v("ownership") !== "Leased" },
      { key: "comprehensive", label: "Comprehensive coverage?", type: "select", options: ["Yes", "No", "Not sure"], sheet: "vehicleDetails",
        showIf: (v) => v("collision") === "Yes" },
      { key: "costNew", label: "Approximate cost when new?", type: "select", sheet: "vehicleDetails",
        options: ["Under $15,000", "$15,000 - $25,000", "$25,000 - $35,000", "$35,000 - $50,000", "$50,000 - $75,000", "Over $75,000"] },
      { key: "ownershipDuration", label: "How long have you owned this vehicle?", type: "select", sheet: "vehicleDetails",
        options: ["Less than 1 year", "1-2 years", "3-5 years", "6-10 years", "More than 10 years"] },
      { key: "purchasedIn90Days", label: "Purchased in the last 90 days?", type: "radio", options: YES_NO, sheet: "vehicleDetails" },
      { key: "AEB", label: "Automatic emergency braking?", type: "radio", options: YES_NO, sheet: "vehicleDetails" },
      { key: "antiTheft", label: "Anti-theft device?", type: "select", sheet: "vehicleDetails",
        options: ["None", "Alarm", "Active Tracking", "Passive Tracking", "Vehicle Recovery System", "Other"] },
    ],
  },
  {
    id: "drivers",
    title: "Add Drivers",
    prefix: "driver",
    entity: { noun: "driver", max: 2, name: (v) => [v("firstName"), v("lastName")].filter(Boolean).join(" ") },
    heading: "Driver details",
    fields: [
      { key: "firstName", label: "First Name", type: "text", required: true, maxLength: 24, sheet: "driverDetails" },
      { key: "lastName", label: "Last Name", type: "text", required: true, maxLength: 25, sheet: "driverDetails" },
      { key: "gender", label: "Gender", type: "select", options: ["Male", "Female", "Non-Binary", "Not-Specified", "Intersex"], required: true, sheet: "driverDetails" },
      { key: "dob", label: "Date of Birth", type: "tel", placeholder: "MM/DD/YYYY", required: true, sheet: "driverDetails" },
      { key: "licenseStatus", label: "Current License Status", type: "select", required: true, sheet: "driverDetails",
        options: ["Valid U.S. License", "Valid Canadian License", "Valid Foreign License", "Not Licensed", "Suspended/Revoked License", "Valid Permit"] },
      { key: "relationship", label: "Relationship to You", type: "select", required: true, sheet: "driverDetails",
        options: ["Spouse", "Child", "Relative", "Domestic Partner", "Other"], showIf: (_v, i) => i > 0 },
      { key: "maritalStatus", label: "Marital Status", type: "select", required: true, sheet: "driverDetails",
        options: ["Single", "Married", "Civil Union/Domestic Partner", "Divorced", "Widowed", "Separated"] },
      { key: "residenceType", label: "Residence Type", type: "select", required: true, sheet: "driverDetails",
        options: ["Own Home", "Own Condo", "Own Mobile Home", "Rent", "Other"], showIf: (_v, i) => i === 0 },
      { key: "primaryVehicle", label: "Which vehicle do you drive most often?", type: "vehicle", required: true, sheet: "driverAssignment" },
      { key: "studentABAverage", label: "Student with B average or better?", type: "radio", options: YES_NO, sheet: "driverDetails" },
      { key: "driverTraining", label: "Completed a driver training course?", type: "radio", options: YES_NO, sheet: "driverDetails" },
      { key: "awayFromHome", label: "Away from home (school or military)?", type: "radio", options: YES_NO, sheet: "driverDetails" },
    ],
  },
  {
    id: "losses",
    title: "Driving History",
    prefix: "loss",
    entity: { noun: "incident", max: 1, name: (v) => v("description") || v("type") },
    heading: "Accidents, tickets and claims",
    fields: [
      // PLACEHOLDER options: the sheet references $selAdmittedAccident / $selAdmittedClaim lists not included in it.
      { key: "type", label: "What happened?", type: "select", options: ["Accident", "Ticket or violation", "Other claim"], required: true, sheet: "autoLossDetailsContent" },
      { key: "description", label: "Description", type: "text", required: true, sheet: "autoLossDetailsContent" },
      { key: "date", label: "When did this happen? (MM/DD/YYYY)", type: "tel", placeholder: "MM/DD/YYYY", required: true, sheet: "autoLossDetailsContent" },
      { key: "atFault", label: "Were you at fault?", type: "radio", options: YES_NO, required: true, sheet: "autoLossDetailsContent",
        showIf: (v) => v("type") === "Accident" },
      { key: "amount", label: "Amount of loss?", type: "text", required: true, sheet: "autoLossDetailsContent" },
      { key: "injuries", label: "Was anyone injured?", type: "radio", options: YES_NO, required: true, sheet: "autoLossDetailsContent" },
      { key: "driver", label: "Driver", type: "driver", required: true, sheet: "autoLossDetailsContent" },
      { key: "catastrophic", label: "Was this caused by a catastrophic event?", type: "radio", options: YES_NO, required: true, sheet: "autoLossDetailsContent",
        showIf: (v) => v("type") === "Other claim" },
    ],
  },
  {
    id: "policy",
    title: "Current Insurance",
    prefix: "policy",
    fields: [
      { key: "currentlyInsured", label: "Do you currently have auto insurance?", type: "radio", options: YES_NO, required: true, sheet: "morequestions" },
      { key: "expiresIn7Days", label: "Will your current auto insurance expire in the next 7 days?", type: "radio", options: YES_NO, required: true, sheet: "morequestions",
        showIf: (v) => v("currentlyInsured") === "Yes" },
      { key: "priorCarrier", label: "Current Auto Insurance Company", type: "text", required: true, sheet: "morequestions",
        showIf: (v) => v("currentlyInsured") !== "No" },
      // Options are months in the sheet (5 to 60); shown as entered until Travelers confirms display labels.
      { key: "monthsWithCarrier", label: "How long have you been with them? (months)", type: "select", options: ["5", "6", "12", "24", "36", "48", "60"], required: true, sheet: "morequestions",
        showIf: (v) => v("currentlyInsured") !== "No" },
      { key: "priorLiabilityLimit", label: "Which bodily injury limit is closest to your current coverage?", type: "select", sheet: "morequestions",
        options: ["State Minimum", "25/50", "50/100", "100/300", "250/500", "500/500", "Not sure"],
        showIf: (v) => v("currentlyInsured") !== "No" },
      { key: "currentPolicies", label: "Which Travelers policies do you have?", type: "text", sheet: "currentpolicies",
        showIf: (v) => v("currentCustomer") === "Yes" },
      { key: "purchasedFromIndependentAgent", label: "Purchased from an independent agent?", type: "radio", options: YES_NO, sheet: "currentpolicies",
        showIf: (v) => v("currentCustomer") === "Yes" },
    ],
  },
  { id: "review", title: "Review", summary: true },
  { id: "rate", title: "Your Rate", rate: true },
];

export const STEP_IDS = STEPS.map((s) => s.id);

export function stepFor(id) {
  return STEPS.find((s) => s.id === id) || null;
}

// "vehicle[1].year" -> step "vehicles"; "client.firstName" -> "client".
export function stepIdForKey(key) {
  const prefix = key.split(/[.[]/)[0];
  const step = STEPS.find((s) => s.prefix === prefix);
  return step ? step.id : "client";
}

export function fieldKey(step, entityIndex, fieldKeyName) {
  return step.entity ? `${step.prefix}[${entityIndex}].${fieldKeyName}` : `${step.prefix}.${fieldKeyName}`;
}

// Keys the flow can send that no step's form asks for (prefill, document, applicant fields asked by AISA).
const EXTRA_LABELS = { vin: "VIN", dob: "Date of Birth", maritalStatus: "Marital Status", relationship: "Relationship to You",
  antiLockBrakes: "Anti-Lock Brakes", travelink: "Travelink Program", excessElectronics: "Excess Electronics",
  excessElectronicsValue: "Excess Electronics Value", electronics: "Electronic Equipment", electronicsValue: "Electronics Value",
  outOfState: "Kept Out of State", outOfStateMilitary: "Out of State (Military/School)",
  currentPolicies: "Current Travelers Policies", purchasedFromIndependentAgent: "Purchased from Independent Agent",
  currentCustomer: "Current Travelers Customer" };

export function labelForKey(key) {
  const step = STEPS.find((s) => s.prefix === key.split(/[.[]/)[0]);
  const name = key.split(".").pop();
  const field = step?.fields?.find((f) => f.key === name)
    || STEPS.flatMap((s) => s.fields || []).find((f) => f.key === name);
  if (field) return field.label;
  if (EXTRA_LABELS[name]) return EXTRA_LABELS[name];
  // Last resort: "annualMiles" -> "Annual miles", never a raw key.
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
