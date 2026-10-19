import { describe, expect, it } from "vitest";
import { resolveRightClickAction } from "./terminalInteraction";

describe("terminal right-click resolution", () => {
  it("always opens the menu when the shortcut is disabled", () => {
    expect(
      resolveRightClickAction({
        enabled: false,
        shiftKey: false,
        hasSelection: true,
        canPaste: true,
      }),
    ).toBe("menu");
    expect(
      resolveRightClickAction({
        enabled: false,
        shiftKey: false,
        hasSelection: false,
        canPaste: true,
      }),
    ).toBe("menu");
  });

  it("keeps Shift as the menu escape hatch", () => {
    expect(
      resolveRightClickAction({
        enabled: true,
        shiftKey: true,
        hasSelection: true,
        canPaste: true,
      }),
    ).toBe("menu");
    expect(
      resolveRightClickAction({
        enabled: true,
        shiftKey: true,
        hasSelection: false,
        canPaste: true,
      }),
    ).toBe("menu");
  });

  it("copies when a selection exists", () => {
    expect(
      resolveRightClickAction({
        enabled: true,
        shiftKey: false,
        hasSelection: true,
        canPaste: false,
      }),
    ).toBe("copy");
  });

  it("pastes when there is no selection and the session accepts input", () => {
    expect(
      resolveRightClickAction({
        enabled: true,
        shiftKey: false,
        hasSelection: false,
        canPaste: true,
      }),
    ).toBe("paste");
  });

  it("falls back to the menu when pasting is not possible", () => {
    expect(
      resolveRightClickAction({
        enabled: true,
        shiftKey: false,
        hasSelection: false,
        canPaste: false,
      }),
    ).toBe("menu");
  });
});
