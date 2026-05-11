import type { VehicleInfo } from "./intake.js";

type VpicResponse = {
  Results?: Record<string, string | null | undefined>[];
};

const variableMap = {
  "Model Year": "year",
  Make: "make",
  Model: "model",
  Trim: "trim",
} as const;

export async function decodeVin(vin: string): Promise<VehicleInfo> {
  const normalizedVin = vin.trim().toUpperCase();
  const response = await fetch(
    `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(normalizedVin)}?format=json`,
  );

  if (!response.ok) {
    throw new Error(`VIN decoder request failed with status ${response.status}.`);
  }

  const data = (await response.json()) as VpicResponse;
  const firstResult = data.Results?.[0];

  if (!firstResult) {
    return { vin: normalizedVin };
  }

  const vehicle: VehicleInfo = { vin: normalizedVin };
  for (const [vpicName, vehicleKey] of Object.entries(variableMap)) {
    const value = cleanVpicValue(firstResult[vpicName]);
    if (value) {
      vehicle[vehicleKey] = value;
    }
  }

  return vehicle;
}

export function formatVehicleInfo(vehicle: VehicleInfo | undefined): string {
  if (!vehicle) return "Vehicle details unavailable.";

  const title = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(" ");
  const vin = vehicle.vin ? `VIN: ${vehicle.vin}` : undefined;

  return [vin, title || undefined].filter(Boolean).join("; ") || "Vehicle details unavailable.";
}

function cleanVpicValue(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();

  if (!trimmed || trimmed.toLowerCase() === "not applicable") {
    return undefined;
  }

  return trimmed;
}
