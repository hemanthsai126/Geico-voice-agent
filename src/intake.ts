import { z } from "zod";

export const intakeFields = [
  "firstName",
  "lastName",
  "age",
  "address",
  "email",
  "phoneNumber",
  "driverLicenseNumber",
  "vin",
] as const;

export type IntakeField = (typeof intakeFields)[number];
export const vehicleFields = ["year", "make", "model", "trim"] as const;
export type VehicleField = (typeof vehicleFields)[number];
export const paymentFields = ["cardNumber", "expirationMonth", "expirationYear", "cvv"] as const;
export type PaymentField = (typeof paymentFields)[number];

export type IntakeStatus = "collecting" | "ready_for_confirmation" | "confirmed";

export type IntakeDraft = {
  firstName?: string;
  lastName?: string;
  age?: number;
  address?: string;
  email?: string;
  phoneNumber?: string;
  driverLicenseNumber?: string;
  vin?: string;
  vehicle?: VehicleInfo;
  quote?: QuoteInfo;
  payment?: PaymentInfo;
};

export type CallState = {
  callSid?: string;
  streamSid?: string;
  status: IntakeStatus;
  draft: IntakeDraft;
  missingFields: IntakeField[];
  updatedAt: Date;
};

export type VehicleInfo = {
  vin: string;
  year?: string;
  make?: string;
  model?: string;
  trim?: string;
};

export type QuoteInfo = {
  monthlyPremium: number;
  termMonths: number;
  coverageSummary: string;
};

export type PaymentInfo = {
  cardNumber?: string;
  expirationMonth?: string;
  expirationYear?: string;
  cvv?: string;
};

export type ConfirmedIntake = Required<Omit<IntakeDraft, "payment">>;

export const confirmedIntakeSchema = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  age: z.coerce.number().int().min(16).max(120),
  address: z.string().trim().min(1),
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  phoneNumber: z
    .string()
    .trim()
    .transform((value) => value.replace(/[\s().-]/g, ""))
    .pipe(z.string().regex(/^\d{10}$/, "Phone number must be exactly 10 digits.")),
  driverLicenseNumber: z.string().trim().min(1),
  vin: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-HJ-NPR-Z0-9]{17}$/i, "VIN must be 17 characters and cannot contain I, O, or Q.")),
  vehicle: z.object({
    vin: z.string(),
    year: z.string().trim().min(1),
    make: z.string().trim().min(1),
    model: z.string().trim().min(1),
    trim: z.string().trim().min(1),
  }),
  quote: z.object({
    monthlyPremium: z.number(),
    termMonths: z.number(),
    coverageSummary: z.string(),
  }),
});

const emailSchema = z.string().email();
const phoneSchema = z.string().regex(/^\d{10}$/, "Phone number must be exactly 10 digits.");
const vinSchema = z
  .string()
  .regex(/^[A-HJ-NPR-Z0-9]{17}$/i, "VIN must be 17 characters and cannot contain I, O, or Q.");

export function createCallState(): CallState {
  return {
    status: "collecting",
    draft: {},
    missingFields: [...intakeFields],
    updatedAt: new Date(),
  };
}

export function updateField(state: CallState, field: IntakeField, rawValue: unknown): CallState {
  const value = normalizeAndValidate(field, rawValue);
  const nextDraft = { ...state.draft, [field]: value };

  return refreshState({
    ...state,
    draft: nextDraft,
    status: "collecting",
  });
}

export function updateVehicleField(state: CallState, field: VehicleField, rawValue: unknown): CallState {
  const value = z.string().trim().min(1).parse(rawValue);

  return refreshState({
    ...state,
    draft: {
      ...state.draft,
      vehicle: {
        vin: state.draft.vin ?? state.draft.vehicle?.vin ?? "",
        ...state.draft.vehicle,
        [field]: value,
      },
    },
  });
}

export function updatePaymentField(state: CallState, field: PaymentField, rawValue: unknown): CallState {
  const value = normalizePaymentField(field, rawValue);

  return refreshState({
    ...state,
    draft: {
      ...state.draft,
      payment: {
        ...state.draft.payment,
        [field]: value,
      },
    },
  });
}

export function markReadyForConfirmation(state: CallState): CallState {
  const refreshed = refreshState(state);

  if (refreshed.missingFields.length > 0) {
    throw new Error(`Cannot confirm yet. Missing: ${refreshed.missingFields.join(", ")}`);
  }

  const missingVehicleFields = getMissingVehicleFields(refreshed.draft);
  if (missingVehicleFields.length > 0) {
    throw new Error(`Cannot confirm yet. Missing vehicle details: ${missingVehicleFields.join(", ")}`);
  }

  if (!refreshed.draft.quote) {
    throw new Error("Cannot confirm yet. Mock quote has not been generated.");
  }

  const missingPaymentFields = getMissingPaymentFields(refreshed.draft);
  if (missingPaymentFields.length > 0) {
    throw new Error(`Cannot confirm yet. Missing payment details: ${missingPaymentFields.join(", ")}`);
  }

  return {
    ...refreshed,
    status: "ready_for_confirmation",
    updatedAt: new Date(),
  };
}

export function confirmIntake(state: CallState): ConfirmedIntake {
  const readyState = markReadyForConfirmation(state);
  const draft = readyState.draft;

  return {
    firstName: draft.firstName!,
    lastName: draft.lastName!,
    age: draft.age!,
    address: draft.address!,
    email: draft.email!,
    phoneNumber: draft.phoneNumber!,
    driverLicenseNumber: draft.driverLicenseNumber!,
    vin: draft.vin!,
    vehicle: {
      vin: draft.vehicle!.vin,
      year: draft.vehicle!.year!,
      make: draft.vehicle!.make!,
      model: draft.vehicle!.model!,
      trim: draft.vehicle!.trim!,
    },
    quote: draft.quote!,
  };
}

export function summarizeIntake(draft: IntakeDraft): string {
  return [
    `First name: ${draft.firstName ?? "missing"}`,
    `Last name: ${draft.lastName ?? "missing"}`,
    `Age: ${draft.age ?? "missing"}`,
    `Address: ${draft.address ?? "missing"}`,
    `Email: ${draft.email ?? "missing"}`,
    `Phone number: ${draft.phoneNumber ?? "missing"}`,
    `Driver license number: ${draft.driverLicenseNumber ?? "missing"}`,
    `VIN: ${draft.vin ?? "missing"}`,
    `Vehicle: ${summarizeVehicle(draft.vehicle)}`,
    `Mock quote: ${summarizeQuote(draft.quote)}`,
    `Payment: ${summarizePayment(draft.payment)}`,
  ].join("\n");
}

export function parseConfirmedIntake(input: unknown): ConfirmedIntake {
  const intake = confirmedIntakeSchema.parse(input);

  return {
    ...intake,
  };
}

export function attachVehicleInfo(state: CallState, vehicle: VehicleInfo): CallState {
  return refreshState({
    ...state,
    draft: {
      ...state.draft,
      vehicle,
    },
  });
}

export function getMissingVehicleFields(draft: IntakeDraft): VehicleField[] {
  if (!draft.vin) return [...vehicleFields];
  return vehicleFields.filter((field) => !draft.vehicle?.[field]);
}

export function getMissingPaymentFields(draft: IntakeDraft): PaymentField[] {
  return paymentFields.filter((field) => !draft.payment?.[field]);
}

function refreshState(state: CallState): CallState {
  const missingFields = intakeFields.filter((field) => state.draft[field] === undefined);

  return {
    ...state,
    missingFields,
    updatedAt: new Date(),
  };
}

function normalizeAndValidate(field: IntakeField, rawValue: unknown): string | number {
  if (field === "age") {
    const age = z.coerce.number().int().min(16).max(120).parse(rawValue);
    return age;
  }

  const value = z.string().trim().min(1).parse(rawValue);

  switch (field) {
    case "email":
      return emailSchema.parse(value).toLowerCase();
    case "phoneNumber":
      return phoneSchema.parse(value.replace(/[\s().-]/g, ""));
    case "driverLicenseNumber":
      return value.toUpperCase();
    case "vin":
      return vinSchema.parse(value).toUpperCase();
    case "firstName":
    case "lastName":
    case "address":
      return value;
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

function normalizePaymentField(field: PaymentField, rawValue: unknown): string {
  const value = z.string().trim().parse(rawValue);

  switch (field) {
    case "cardNumber":
      return z.string().regex(/^\d{13,19}$/, "Card number must be 13 to 19 digits.").parse(value.replace(/\D/g, ""));
    case "expirationMonth":
      return z.string().regex(/^(0?[1-9]|1[0-2])$/, "Expiration month must be 1 through 12.").parse(value);
    case "expirationYear":
      return z.string().regex(/^(\d{2}|\d{4})$/, "Expiration year must be 2 or 4 digits.").parse(value);
    case "cvv":
      return z.string().regex(/^\d{3,4}$/, "CVV must be 3 or 4 digits.").parse(value);
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

function summarizeVehicle(vehicle: VehicleInfo | undefined): string {
  if (!vehicle) return "not decoded yet";

  const details = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(" ");
  return details || "decoded, details unavailable";
}

function summarizeQuote(quote: QuoteInfo | undefined): string {
  if (!quote) return "not generated yet";

  return `$${quote.monthlyPremium} per month for ${quote.termMonths} months. ${quote.coverageSummary}`;
}

function summarizePayment(payment: PaymentInfo | undefined): string {
  if (!payment) return "not collected";

  const lastFour = payment.cardNumber?.slice(-4);
  return lastFour ? `card ending in ${lastFour}; not stored` : "partially collected; not stored";
}
