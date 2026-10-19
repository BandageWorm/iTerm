import { describe, expect, it } from "vitest";
import { resolveCompletionPlacement } from "./completionPlacement";

const base = {
  rows: 24,
  rowHeight: 20,
  paneHeight: 480,
};

describe("inline completion placement", () => {
  it("anchors above the input line when the cursor sits on the last row", () => {
    expect(resolveCompletionPlacement({ ...base, cursorRow: 23 })).toEqual({
      placement: "above",
      offset: 24,
      maxHeight: 188,
    });
  });

  it("flips below the cursor when the cursor sits on the first row", () => {
    expect(resolveCompletionPlacement({ ...base, cursorRow: 0 })).toEqual({
      placement: "below",
      offset: 24,
      maxHeight: 188,
    });
  });

  it("compresses the popup instead of flipping when room above is short", () => {
    // 光标在第 8 行：上方 152px 放不下 188px 的浮层，但仍然够用。
    expect(resolveCompletionPlacement({ ...base, cursorRow: 8 })).toEqual({
      placement: "above",
      offset: 324,
      maxHeight: 152,
    });
  });

  it("stays above and caps the height in a short pane", () => {
    // 6 行高的面板，光标在第 5 行：上方只有 92px，浮层压到 92px 并贴住输入行。
    expect(
      resolveCompletionPlacement({
        rows: 6,
        rowHeight: 20,
        cursorRow: 5,
        paneHeight: 120,
      }),
    ).toEqual({ placement: "above", offset: 24, maxHeight: 92 });
  });

  it("keeps hugging the nearer side when neither side fits", () => {
    expect(
      resolveCompletionPlacement({
        rows: 4,
        rowHeight: 20,
        cursorRow: 2,
        paneHeight: 80,
      }),
    ).toEqual({ placement: "above", offset: 44, maxHeight: 32 });
  });

  it("clamps an out-of-range cursor row into the viewport", () => {
    expect(resolveCompletionPlacement({ ...base, cursorRow: 99 })).toEqual({
      placement: "above",
      offset: 24,
      maxHeight: 188,
    });
  });

  it("honours custom gap and margin", () => {
    expect(
      resolveCompletionPlacement({
        ...base,
        cursorRow: 23,
        gap: 8,
        margin: 12,
      }),
    ).toEqual({ placement: "above", offset: 28, maxHeight: 188 });
  });

  it("caps the height at the configured maximum", () => {
    expect(
      resolveCompletionPlacement({
        ...base,
        cursorRow: 23,
        maxVisibleHeight: 120,
      }),
    ).toEqual({ placement: "above", offset: 24, maxHeight: 120 });
  });

  it("never returns a negative height", () => {
    expect(
      resolveCompletionPlacement({
        rows: 1,
        rowHeight: 20,
        cursorRow: 0,
        paneHeight: 4,
      }),
    ).toEqual({ placement: "above", offset: 8, maxHeight: 0 });
  });
});
