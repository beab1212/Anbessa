// Google's encoded polyline, precision 6 (what OSRM returns with `geometries=polyline6`). Only
// the encoder lives here: the fallback route draws a straight line in the same format.

import type { LatLng } from "@ride-app/shared-location";

export function encodePolyline6(points: LatLng[]): string {
  let out = "";
  let prevLat = 0;
  let prevLng = 0;
  const write = (v: number) => {
    let value = v < 0 ? ~(v << 1) : v << 1;
    while (value >= 0x20) {
      out += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
      value >>= 5;
    }
    out += String.fromCharCode(value + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e6);
    const lng = Math.round(p.lng * 1e6);
    write(lat - prevLat);
    write(lng - prevLng);
    prevLat = lat;
    prevLng = lng;
  }
  return out;
}
