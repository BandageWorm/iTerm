import { setPersistentItem } from "./persistence";
import type { LineEnding } from "./types";

export const QUICK_COMMANDS_STORAGE_KEY = "iterm.quick-commands.v1";
export const MAX_QUICK_COMMANDS = 50;
export const MAX_QUICK_COMMAND_LENGTH = 4_096;

export type QuickCommandLineEnding = LineEnding | "terminal";

export interface QuickCommand {
  id: string;
  name: string;
  payload: string;
  lineEnding: QuickCommandLineEnding;
}

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "getItem" | "setItem">;

const LINE_ENDINGS: readonly QuickCommandLineEnding[] = [
  "none",
  "lf",
  "cr",
  "crlf",
  "terminal",
];

function isLineEnding(value: unknown): value is QuickCommandLineEnding {
  return LINE_ENDINGS.includes(value as QuickCommandLineEnding);
}

function normalizeEntry(entry: unknown): QuickCommand | null {
  if (!entry || typeof entry !== "object") return null;
  const candidate = entry as Partial<QuickCommand>;
  if (typeof candidate.payload !== "string" || !candidate.payload.trim()) {
    return null;
  }
  return {
    id:
      typeof candidate.id === "string" && candidate.id
        ? candidate.id
        : crypto.randomUUID(),
    name: typeof candidate.name === "string" ? candidate.name : "",
    payload: candidate.payload.slice(0, MAX_QUICK_COMMAND_LENGTH),
    lineEnding: isLineEnding(candidate.lineEnding)
      ? candidate.lineEnding
      : "terminal",
  };
}

export function loadQuickCommands(storage: ReadStorage = localStorage): QuickCommand[] {
  try {
    const parsed = JSON.parse(
      storage.getItem(QUICK_COMMANDS_STORAGE_KEY) ?? "[]",
    ) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .flatMap((entry) => {
        const normalized = normalizeEntry(entry);
        return normalized ? [normalized] : [];
      })
      .slice(0, MAX_QUICK_COMMANDS);
  } catch {
    return [];
  }
}

export function saveQuickCommands(
  commands: QuickCommand[],
  storage: WriteStorage = localStorage,
): void {
  setPersistentItem(
    QUICK_COMMANDS_STORAGE_KEY,
    JSON.stringify(commands.slice(0, MAX_QUICK_COMMANDS)),
    storage,
  );
}

export function quickCommandLabel(command: QuickCommand): string {
  const name = command.name.trim();
  return name || command.payload.trim();
}

export function canAddQuickCommand(commands: QuickCommand[]): boolean {
  return commands.length < MAX_QUICK_COMMANDS;
}

export function createQuickCommand(
  payload = "",
  name = "",
  lineEnding: QuickCommandLineEnding = "terminal",
): QuickCommand {
  return {
    id: crypto.randomUUID(),
    name,
    payload: payload.slice(0, MAX_QUICK_COMMAND_LENGTH),
    lineEnding,
  };
}

export function addQuickCommand(
  commands: QuickCommand[],
  command: QuickCommand,
): QuickCommand[] {
  if (!canAddQuickCommand(commands)) return commands;
  if (!command.payload.trim()) return commands;
  return [...commands, command];
}

export function updateQuickCommand(
  commands: QuickCommand[],
  id: string,
  patch: Partial<Omit<QuickCommand, "id">>,
): QuickCommand[] {
  return commands.map((command) =>
    command.id === id
      ? {
          ...command,
          ...patch,
          id: command.id,
          payload:
            typeof patch.payload === "string"
              ? patch.payload.slice(0, MAX_QUICK_COMMAND_LENGTH)
              : command.payload,
          lineEnding: isLineEnding(patch.lineEnding)
            ? patch.lineEnding
            : command.lineEnding,
        }
      : command,
  );
}

export function removeQuickCommand(
  commands: QuickCommand[],
  id: string,
): QuickCommand[] {
  return commands.filter((command) => command.id !== id);
}

export function moveQuickCommand(
  commands: QuickCommand[],
  id: string,
  offset: -1 | 1,
): QuickCommand[] {
  const index = commands.findIndex((command) => command.id === id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= commands.length) return commands;
  const next = [...commands];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

export function duplicateQuickCommand(
  commands: QuickCommand[],
  id: string,
  copySuffix = "副本",
): QuickCommand[] {
  const source = commands.find((command) => command.id === id);
  if (!source || !canAddQuickCommand(commands)) return commands;
  const label = quickCommandLabel(source);
  return [
    ...commands,
    {
      ...source,
      id: crypto.randomUUID(),
      name: `${label} ${copySuffix}`,
    },
  ];
}

export function hasQuickCommandPayload(
  commands: QuickCommand[],
  payload: string,
): boolean {
  const normalized = payload.trim();
  if (!normalized) return true;
  return commands.some((command) => command.payload.trim() === normalized);
}

export function importQuickCommand(
  commands: QuickCommand[],
  payload: string,
  name = "",
): QuickCommand[] {
  if (hasQuickCommandPayload(commands, payload)) return commands;
  return addQuickCommand(commands, createQuickCommand(payload, name));
}
