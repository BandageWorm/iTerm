import { describe, expect, it } from "vitest";
import {
  addQuickCommand,
  createQuickCommand,
  duplicateQuickCommand,
  hasQuickCommandPayload,
  importQuickCommand,
  loadQuickCommands,
  MAX_QUICK_COMMANDS,
  MAX_QUICK_COMMAND_LENGTH,
  moveQuickCommand,
  quickCommandLabel,
  removeQuickCommand,
  saveQuickCommands,
  updateQuickCommand,
} from "./quickCommands";

function createStorage(initial = "[]") {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
    read: () => value,
  };
}

describe("quick commands store", () => {
  it("round-trips commands in user-defined order", () => {
    const storage = createStorage();
    const commands = [
      createQuickCommand("git status", "查看状态", "cr"),
      createQuickCommand("reboot", "重启", "lf"),
    ];
    saveQuickCommands(commands, storage);

    expect(loadQuickCommands(storage)).toEqual(commands);
  });

  it("drops entries without a payload and truncates oversized payloads", () => {
    const storage = createStorage(
      JSON.stringify([
        { id: "one", name: "missing payload" },
        { id: "two", payload: "   " },
        { id: "three", payload: "x".repeat(MAX_QUICK_COMMAND_LENGTH + 50) },
      ]),
    );

    const loaded = loadQuickCommands(storage);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("three");
    expect(loaded[0].payload).toHaveLength(MAX_QUICK_COMMAND_LENGTH);
    expect(loaded[0].lineEnding).toBe("terminal");
  });

  it("falls back to an empty list for corrupt or non-array data", () => {
    expect(loadQuickCommands(createStorage("{broken"))).toEqual([]);
    expect(loadQuickCommands(createStorage('{"payload":"ls"}'))).toEqual([]);
  });

  it("caps the stored list at the maximum size", () => {
    const storage = createStorage();
    const commands = Array.from({ length: MAX_QUICK_COMMANDS + 10 }, (_, index) =>
      createQuickCommand(`command-${index}`, `c${index}`),
    );
    saveQuickCommands(commands, storage);

    expect(loadQuickCommands(storage)).toHaveLength(MAX_QUICK_COMMANDS);
  });

  it("refuses to append beyond the maximum size", () => {
    const commands = Array.from({ length: MAX_QUICK_COMMANDS }, (_, index) =>
      createQuickCommand(`command-${index}`),
    );
    const next = addQuickCommand(commands, createQuickCommand("one-more"));

    expect(next).toBe(commands);
  });

  it("updates, removes, and reorders commands without mutating the input", () => {
    const first = createQuickCommand("ls", "列出");
    const second = createQuickCommand("df -h", "磁盘");
    const third = createQuickCommand("reboot", "重启");
    const commands = [first, second, third];

    expect(updateQuickCommand(commands, second.id, { name: "磁盘占用" })[1].name).toBe(
      "磁盘占用",
    );
    expect(removeQuickCommand(commands, second.id)).toEqual([first, third]);
    expect(moveQuickCommand(commands, third.id, -1)).toEqual([
      first,
      third,
      second,
    ]);
    expect(moveQuickCommand(commands, first.id, -1)).toBe(commands);
    expect(moveQuickCommand(commands, third.id, 1)).toBe(commands);
    expect(commands).toEqual([first, second, third]);
  });

  it("duplicates a command with a distinguishable label", () => {
    const source = createQuickCommand("reboot", "重启");
    const next = duplicateQuickCommand([source], source.id);

    expect(next).toHaveLength(2);
    expect(next[1].id).not.toBe(source.id);
    expect(next[1].payload).toBe("reboot");
    expect(quickCommandLabel(next[1])).toBe("重启 副本");
  });

  it("collects a history payload once and ignores duplicates", () => {
    const commands = importQuickCommand([], "git log --oneline");
    expect(hasQuickCommandPayload(commands, "  git log --oneline ")).toBe(true);
    expect(importQuickCommand(commands, "git log --oneline")).toBe(commands);
    expect(importQuickCommand(commands, "   ")).toBe(commands);
    expect(commands[0].lineEnding).toBe("terminal");
  });

  it("labels unnamed commands with their payload", () => {
    expect(quickCommandLabel(createQuickCommand("reboot"))).toBe("reboot");
  });
});
