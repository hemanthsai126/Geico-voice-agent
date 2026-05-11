import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatVehicleInfo } from "../src/vinDecoder.js";

describe("vehicle formatting", () => {
  it("formats only decoded year, make, model, and trim", () => {
    const summary = formatVehicleInfo({
      vin: "1HGCM82633A004352",
      year: "2003",
      make: "HONDA",
      model: "Accord",
      trim: "EX",
    });

    assert.equal(summary, "VIN: 1HGCM82633A004352; 2003 HONDA Accord EX");
  });

  it("handles missing decoded details", () => {
    assert.equal(formatVehicleInfo({ vin: "1HGCM82633A004352" }), "VIN: 1HGCM82633A004352");
  });
});
