import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_SNAPSHOT,
  loadWorkspaceSnapshot,
  saveWorkspaceSnapshot,
  type WorkspaceSnapshot,
} from "./workspace";

describe("workspace persistence", () => {
  it("round-trips a valid snapshot", () => {
    let stored = "";
    const snapshot: WorkspaceSnapshot = {
      sidebarOpen: false,
      senderOpen: true,
      quickBarOpen: false,
      openProfileIds: ["one", "two"],
      activeProfileId: "two",
      splitMode: "horizontal",
      splitProfileIds: ["one", "two"],
    };
    saveWorkspaceSnapshot(snapshot, {
      setItem: (_key, value) => {
        stored = value;
      },
    });

    expect(
      loadWorkspaceSnapshot({
        getItem: () => stored,
      }),
    ).toEqual(snapshot);
  });

  it("falls back safely for corrupt data", () => {
    expect(
      loadWorkspaceSnapshot({
        getItem: () => "{broken",
      }),
    ).toEqual(DEFAULT_WORKSPACE_SNAPSHOT);
  });

  it("defaults the quick command bar to open when the field is missing or invalid", () => {
    expect(
      loadWorkspaceSnapshot({
        getItem: () => JSON.stringify({ sidebarOpen: true, senderOpen: true }),
      }).quickBarOpen,
    ).toBe(true);
    expect(
      loadWorkspaceSnapshot({
        getItem: () => JSON.stringify({ quickBarOpen: "yes" }),
      }).quickBarOpen,
    ).toBe(true);
    expect(
      loadWorkspaceSnapshot({
        getItem: () => JSON.stringify({ quickBarOpen: false }),
      }).quickBarOpen,
    ).toBe(false);
  });
});
