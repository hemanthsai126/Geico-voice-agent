import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  confirmIntake,
  createCallState,
  attachVehicleInfo,
  markReadyForConfirmation,
  parseConfirmedIntake,
  summarizeIntake,
  updateField,
  updatePaymentField,
} from "../src/intake.js";

describe("intake state", () => {
  it("tracks missing fields as data is collected", () => {
    let state = createCallState();

    state = updateField(state, "firstName", "Ada");
    state = updateField(state, "lastName", "Lovelace");

    assert.deepEqual(state.missingFields, ["age", "address", "email", "phoneNumber", "driverLicenseNumber", "vin"]);
    assert.equal(state.status, "collecting");
  });

  it("normalizes email, phone, driver license, and VIN values", () => {
    let state = createCallState();

    state = updateField(state, "email", "ADA@EXAMPLE.COM");
    state = updateField(state, "phoneNumber", "(555) 123-4567");
    state = updateField(state, "driverLicenseNumber", "d1234567");
    state = updateField(state, "vin", "1hgcm82633a004352");

    assert.equal(state.draft.email, "ada@example.com");
    assert.equal(state.draft.phoneNumber, "5551234567");
    assert.equal(state.draft.driverLicenseNumber, "D1234567");
    assert.equal(state.draft.vin, "1HGCM82633A004352");
  });

  it("normalizes +1 NANP phones, punctuation, or numeric payloads to ten digits", () => {
    let state = updateField(createCallState(), "phoneNumber", "+15125550123");
    assert.equal(state.draft.phoneNumber, "5125550123");

    state = updateField(createCallState(), "phoneNumber", "+1 (512) 555-0123");
    assert.equal(state.draft.phoneNumber, "5125550123");

    state = updateField(createCallState(), "phoneNumber", 15125550123);
    assert.equal(state.draft.phoneNumber, "5125550123");
  });

  it("rejects phones that cannot be reduced to exactly ten NANP digits", () => {
    assert.throws(() => updateField(createCallState(), "phoneNumber", "+447700900123"), /exactly 10 digits/);
    assert.throws(() => updateField(createCallState(), "phoneNumber", "12345"), /exactly 10 digits/);
  });

  it("parses confirmed intake payloads with optional +1 on save", () => {
    const baseline = confirmIntake(completeReadyState());
    const reparsed = parseConfirmedIntake({ ...baseline, phoneNumber: "+1 512 555 0123" });
    assert.equal(reparsed.phoneNumber, "5125550123");
  });

  it("does not allow confirmation until every field is present", () => {
    const state = updateField(createCallState(), "firstName", "Ada");

    assert.throws(() => markReadyForConfirmation(state), /Missing/);
  });

  it("returns confirmed intake only after all fields are present", () => {
    const state = completeReadyState();

    const confirmed = confirmIntake(state);

    assert.deepEqual(confirmed, {
      firstName: "Ada",
      lastName: "Lovelace",
      age: 36,
      address: "123 Main St, Austin, TX",
      email: "ada@example.com",
      phoneNumber: "5125550123",
      driverLicenseNumber: "D1234567",
      vin: "1HGCM82633A004352",
      vehicle: {
        vin: "1HGCM82633A004352",
        year: "2003",
        make: "HONDA",
        model: "Accord",
        trim: "EX",
      },
      quote: {
        monthlyPremium: 125,
        termMonths: 6,
        coverageSummary: "Mock full auto package.",
      },
    });
    assert.equal("payment" in confirmed, false);
  });

  it("includes attached vehicle info in confirmed intake", () => {
    const state = completeReadyState();

    assert.equal(confirmIntake(state).vehicle?.make, "HONDA");
  });

  it("does not allow confirmation without quote and payment details", () => {
    let state = createCallState();
    state = updateField(state, "firstName", "Ada");
    state = updateField(state, "lastName", "Lovelace");
    state = updateField(state, "age", 36);
    state = updateField(state, "address", "123 Main St, Austin, TX");
    state = updateField(state, "email", "ada@example.com");
    state = updateField(state, "phoneNumber", "5125550123");
    state = updateField(state, "driverLicenseNumber", "D1234567");
    state = updateField(state, "vin", "1HGCM82633A004352");
    state = attachVehicleInfo(state, {
      vin: "1HGCM82633A004352",
      year: "2003",
      make: "HONDA",
      model: "Accord",
      trim: "EX",
    });

    assert.throws(() => markReadyForConfirmation(state), /A quote has not been generated|quote has not been generated/i);
  });

  it("summarizes missing and captured values for readback", () => {
    const state = updateField(createCallState(), "firstName", "Ada");

    assert.match(summarizeIntake(state.draft), /First name: Ada/);
    assert.match(summarizeIntake(state.draft), /VIN: missing/);
  });
});

function completeReadyState() {
  let state = createCallState();
  state = updateField(state, "firstName", "Ada");
  state = updateField(state, "lastName", "Lovelace");
  state = updateField(state, "age", 36);
  state = updateField(state, "address", "123 Main St, Austin, TX");
  state = updateField(state, "email", "ada@example.com");
  state = updateField(state, "phoneNumber", "5125550123");
  state = updateField(state, "driverLicenseNumber", "D1234567");
  state = updateField(state, "vin", "1HGCM82633A004352");
  state = attachVehicleInfo(state, {
    vin: "1HGCM82633A004352",
    year: "2003",
    make: "HONDA",
    model: "Accord",
    trim: "EX",
  });
  state.draft.quote = {
    monthlyPremium: 125,
    termMonths: 6,
    coverageSummary: "Mock full auto package.",
  };
  state = updatePaymentField(state, "cardNumber", "4111111111111111");
  state = updatePaymentField(state, "expirationMonth", "12");
  state = updatePaymentField(state, "expirationYear", "2030");
  state = updatePaymentField(state, "cvv", "123");
  return state;
}
