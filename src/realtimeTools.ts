const updateCollectedFieldParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    field: {
      type: "string",
      enum: ["firstName", "lastName", "age", "address", "email", "phoneNumber", "driverLicenseNumber", "vin"],
    },
    value: {
      type: ["string", "number"],
    },
  },
  required: ["field", "value"],
} as const;

const emptyParameters = {
  type: "object",
  additionalProperties: false,
  properties: {},
  required: [] as string[],
} as const;

/** Shared OpenAI-format tool list for browser realtime intake. */
export const realtimeIntakeTools = [
  {
    type: "function",
    name: "update_collected_field",
    description: "Update one collected intake field after the user provides or corrects it.",
    parameters: updateCollectedFieldParameters,
  },
  {
    type: "function",
    name: "update_vehicle_field",
    description: "Update one missing vehicle detail after VIN decoding leaves it blank or the user corrects it.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        field: {
          type: "string",
          enum: ["year", "make", "model", "trim"],
        },
        value: {
          type: "string",
        },
      },
      required: ["field", "value"],
    },
  },
  {
    type: "function",
    name: "collect_payment_detail",
    description:
      "Record one checkout payment detail in session memory only. Card data must never be written to Firebase or long-term storage.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        field: {
          type: "string",
          enum: ["cardNumber", "expirationMonth", "expirationYear", "cvv"],
        },
        value: {
          type: "string",
        },
      },
      required: ["field", "value"],
    },
  },
  {
    type: "function",
    name: "begin_payment_collection",
    description:
      "Pause conversation recording before any payment/card questions so spoken card digits are not stored in the recording. Call once immediately before the first payment question; required every time checkout starts after the quote is read.",
    parameters: emptyParameters,
  },
  {
    type: "function",
    name: "save_confirmed_intake",
    description: "Save the intake only after the user explicitly confirms the full summary.",
    parameters: emptyParameters,
  },
  {
    type: "function",
    name: "search_auto_insurance_knowledge",
    description: "Search the local GEICO auto-insurance knowledge base before answering auto-insurance questions.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
        },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "generate_quote",
    description:
      "Generate the vehicle-insurance quote after all required customer and vehicle details are captured. Premium, coverage, and term appear only after this returns.",
    parameters: emptyParameters,
  },
] as const;
