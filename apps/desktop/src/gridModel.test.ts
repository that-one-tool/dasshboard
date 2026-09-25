import { describe, it, expect } from "vitest";
import {
  MIN_TRACK_FRACTION,
  PRESET_IDS,
  cumulativeFractions,
  equalSizes,
  normalizeSizes,
  paneCount,
  presetIdFor,
  presetToModel,
  remapPanes,
  resizeTrack,
  shrinkConfirmMessage,
  type PresetId,
} from "./gridModel";

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const closeTo1 = (xs: number[]): void => expect(sum(xs)).toBeCloseTo(1, 10);

describe("presetToModel", () => {
  const expected: Record<PresetId, { rows: number; cols: number }> = {
    "1x1": { rows: 1, cols: 1 },
    "2x1": { rows: 2, cols: 1 },
    "1x2": { rows: 1, cols: 2 },
    "2x2": { rows: 2, cols: 2 },
    "3x1": { rows: 3, cols: 1 },
    "3x2": { rows: 3, cols: 2 },
  };

  for (const id of PRESET_IDS) {
    it(`builds ${id} with the right shape and normalized equal sizes`, () => {
      const m = presetToModel(id);
      expect(m.rows).toBe(expected[id].rows);
      expect(m.cols).toBe(expected[id].cols);
      expect(m.rowSizes).toHaveLength(m.rows);
      expect(m.colSizes).toHaveLength(m.cols);
      expect(paneCount(m)).toBe(m.rows * m.cols);
      closeTo1(m.rowSizes);
      closeTo1(m.colSizes);
      // Equal tracks: every fraction identical.
      for (const f of m.rowSizes) expect(f).toBeCloseTo(1 / m.rows, 10);
      for (const f of m.colSizes) expect(f).toBeCloseTo(1 / m.cols, 10);
    });
  }
});

describe("normalizeSizes / equalSizes", () => {
  it("scales an arbitrary list to sum 1 while preserving ratios", () => {
    const out = normalizeSizes([2, 6]);
    closeTo1(out);
    expect(out[1] ?? 0).toBeCloseTo((out[0] ?? 0) * 3, 10);
  });

  it("falls back to equal fractions for a zero sum", () => {
    expect(normalizeSizes([0, 0, 0])).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it("returns [] for empty input", () => {
    expect(normalizeSizes([])).toEqual([]);
    expect(equalSizes(0)).toEqual([]);
    expect(equalSizes(-2)).toEqual([]);
  });

  it("equalSizes(n) is normalized and equal", () => {
    const out = equalSizes(3);
    closeTo1(out);
    expect(out.every((f) => Math.abs(f - 1 / 3) < 1e-12)).toBe(true);
  });
});

describe("cumulativeFractions", () => {
  it("returns n-1 boundaries at running sums", () => {
    expect(cumulativeFractions([0.2, 0.3, 0.5])).toEqual([0.2, 0.5]);
  });

  it("returns [] for a single track", () => {
    expect(cumulativeFractions([1])).toEqual([]);
  });
});

describe("resizeTrack", () => {
  it("moves the boundary to the pointer and preserves the pair total", () => {
    const out = resizeTrack([0.5, 0.5], 0, 0.7);
    closeTo1(out);
    expect(out[0] ?? 0).toBeCloseTo(0.7, 10);
    expect(out[1] ?? 0).toBeCloseTo(0.3, 10);
  });

  it("leaves tracks outside the dragged pair untouched", () => {
    const out = resizeTrack([0.25, 0.25, 0.5], 0, 0.1);
    // Third track keeps its 0.5 share; only the first pair rebalanced.
    expect(out[2] ?? 0).toBeCloseTo(0.5, 10);
    closeTo1(out);
  });

  it("clamps the first track to the 0.15 minimum when dragged too far left", () => {
    const out = resizeTrack([0.5, 0.5], 0, 0.01);
    expect(out[0] ?? 0).toBeCloseTo(MIN_TRACK_FRACTION, 10);
    expect(out[1] ?? 0).toBeCloseTo(1 - MIN_TRACK_FRACTION, 10);
  });

  it("clamps the second track to the 0.15 minimum when dragged too far right", () => {
    const out = resizeTrack([0.5, 0.5], 0, 0.99);
    expect(out[1] ?? 0).toBeCloseTo(MIN_TRACK_FRACTION, 10);
    expect(out[0] ?? 0).toBeCloseTo(1 - MIN_TRACK_FRACTION, 10);
  });

  it("respects the offset of preceding tracks (middle boundary)", () => {
    // Boundary 1 sits between tracks 1 and 2; before-sum is 0.3.
    const out = resizeTrack([0.3, 0.3, 0.4], 1, 0.6);
    expect(out[1] ?? 0).toBeCloseTo(0.3, 10); // 0.6 - 0.3 before
    expect(out[2] ?? 0).toBeCloseTo(0.4, 10);
    expect(out[0] ?? 0).toBeCloseTo(0.3, 10);
    closeTo1(out);
  });

  it("is a no-op for an out-of-range boundary", () => {
    expect(resizeTrack([0.5, 0.5], 1, 0.7)).toEqual([0.5, 0.5]);
    expect(resizeTrack([0.5, 0.5], -1, 0.7)).toEqual([0.5, 0.5]);
  });

  it("never lets any track fall below the minimum, whatever the target", () => {
    for (let t = -0.5; t <= 1.5; t += 0.05) {
      const out = resizeTrack([0.4, 0.3, 0.3], 0, t);
      for (const f of out) expect(f).toBeGreaterThanOrEqual(MIN_TRACK_FRACTION - 1e-9);
      closeTo1(out);
    }
  });

  it("does not accumulate drift after many simulated drags", () => {
    let sizes = equalSizes(3);
    // Hammer both boundaries with pseudo-random targets many times.
    let seed = 1;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 5000; i++) {
      const boundary = i % 2;
      sizes = resizeTrack(sizes, boundary, rnd());
    }
    closeTo1(sizes);
    for (const f of sizes) expect(f).toBeGreaterThanOrEqual(MIN_TRACK_FRACTION - 1e-9);
  });
});

describe("remapPanes", () => {
  it("keeps the shared prefix and drops the tail on a shrink (2x2 -> 1x2)", () => {
    const r = remapPanes(4, 2);
    expect(r.keep).toEqual([0, 1]);
    expect(r.dropped).toEqual([2, 3]);
    expect(r.added).toEqual([]);
  });

  it("keeps everything and appends on a grow (1x2 -> 2x2)", () => {
    const r = remapPanes(2, 4);
    expect(r.keep).toEqual([0, 1]);
    expect(r.dropped).toEqual([]);
    expect(r.added).toEqual([2, 3]);
  });

  it("is identity for an equal count (2x1 -> 1x2)", () => {
    const r = remapPanes(2, 2);
    expect(r.keep).toEqual([0, 1]);
    expect(r.dropped).toEqual([]);
    expect(r.added).toEqual([]);
  });

  it("handles growing from empty and shrinking to empty", () => {
    expect(remapPanes(0, 3)).toEqual({ keep: [], dropped: [], added: [0, 1, 2] });
    expect(remapPanes(3, 0)).toEqual({ keep: [], dropped: [0, 1, 2], added: [] });
  });

  it("covers the 6-cell max preset (2x2 -> 3x2)", () => {
    const r = remapPanes(4, 6);
    expect(r.keep).toEqual([0, 1, 2, 3]);
    expect(r.added).toEqual([4, 5]);
    expect(r.dropped).toEqual([]);
  });
});

describe("presetIdFor", () => {
  it("matches a model's shape back to its preset id (sizes irrelevant)", () => {
    const m = presetToModel("3x2");
    // Drift the sizes; the preset id still depends only on rows/cols.
    m.colSizes = [0.8, 0.2];
    expect(presetIdFor(m)).toBe("3x2");
  });

  it("returns null for a shape with no preset", () => {
    expect(presetIdFor({ rows: 4, cols: 4, rowSizes: [], colSizes: [] })).toBeNull();
  });
});

describe("shrinkConfirmMessage", () => {
  it("uses the singular for one session", () => {
    expect(shrinkConfirmMessage(1)).toBe(
      "1 active session will be closed. Continue?",
    );
  });

  it("uses the plural for several", () => {
    expect(shrinkConfirmMessage(3)).toBe(
      "3 active sessions will be closed. Continue?",
    );
  });
});
