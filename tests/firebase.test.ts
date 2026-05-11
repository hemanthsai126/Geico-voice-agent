import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildIntakeRecord } from "../src/firebase.js";

describe("firebase record construction", () => {
  it("builds a confirmed Firestore payload with call metadata", () => {
    const record = buildIntakeRecord({
      callSid: "CA123",
      intake: {
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
      },
    });

    assert.equal(record.firstName, "Ada");
    assert.equal(record.status, "confirmed");
    assert.equal(record.voiceSessionId, "CA123");
    assert.ok(record.createdAt);
    assert.ok(record.updatedAt);
  });
});
