// Fares (workflow 15). The fare card per city and vehicle type comes from the live `fares.*`
// settings (admin dashboard → Settings → Fares, sensitive: a second super admin approves). The
// price is a pure function of that card and the route, so a quote can always be explained.

import { settingDef, type SettingsReader } from "@ride-app/shared-settings";

export interface FareCard {
  baseMinor: number;
  perKmMinor: number;
  perMinMinor: number;
  minFareMinor: number;
  waitingPerMinMinor: number;
}

export interface FareBreakdown {
  baseMinor: number;
  distanceMinor: number;
  timeMinor: number;
  /** raised to the minimum fare */
  minimumApplied: boolean;
  /** rounded to whole birr, like a meter shows */
  roundingMinor: number;
}

/** The card for a vehicle type in a city, or null when the type has no fares. */
export function fareCard(settings: SettingsReader, vehicleType: string, cityId: string): FareCard | null {
  const key = (part: string) => `fares.${vehicleType}.${part}`;
  if (!settingDef(key("baseMinor"))) return null;
  return {
    baseMinor: settings.get<number>(key("baseMinor"), cityId),
    perKmMinor: settings.get<number>(key("perKmMinor"), cityId),
    perMinMinor: settings.get<number>(key("perMinMinor"), cityId),
    minFareMinor: settings.get<number>(key("minFareMinor"), cityId),
    waitingPerMinMinor: settings.get<number>(key("waitingPerMinMinor"), cityId),
  };
}

/** base + km × per-km + minutes × per-minute, rounded to whole birr, at least the minimum. */
export function price(card: FareCard, route: { distanceMeters: number; durationSeconds: number }): { fareMinor: number; breakdown: FareBreakdown } {
  const distanceMinor = Math.round((route.distanceMeters / 1000) * card.perKmMinor);
  const timeMinor = Math.round((route.durationSeconds / 60) * card.perMinMinor);
  const raw = card.baseMinor + distanceMinor + timeMinor;
  const rounded = Math.round(raw / 100) * 100;
  const fareMinor = Math.max(card.minFareMinor, rounded);
  return {
    fareMinor,
    breakdown: {
      baseMinor: card.baseMinor, distanceMinor, timeMinor,
      minimumApplied: fareMinor > rounded, roundingMinor: rounded - raw,
    },
  };
}
