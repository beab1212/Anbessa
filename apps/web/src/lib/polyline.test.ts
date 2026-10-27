import { describe, expect, it } from "vitest";
import { decodePolyline6 } from "./polyline";

describe("decodePolyline6", () => {
  it("decodes Google's reference line (at precision 6 the values are a tenth of the 1e5 ones)", () => {
    const pts = decodePolyline6("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(pts).toHaveLength(3);
    expect(pts[0]!.lat).toBeCloseTo(3.85, 6);
    expect(pts[0]!.lng).toBeCloseTo(-12.02, 6);
    expect(pts[2]!.lat).toBeCloseTo(4.3252, 6);
    expect(pts[2]!.lng).toBeCloseTo(-12.6453, 6);
  });

  it("an empty string is no points", () => {
    expect(decodePolyline6("")).toEqual([]);
  });
});
