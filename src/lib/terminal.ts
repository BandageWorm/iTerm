export type TerminalResetMode = "soft" | "hard";

export const DEC_SOFT_RESET_SEQUENCE = "\u001b[!p";
export const DEFAULT_TERMINAL_FONT_SIZE = 14;
export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 40;
export const TERMINAL_CONVERT_EOL = true;

export function clampTerminalFontSize(fontSize: number): number {
  return Math.min(
    MAX_TERMINAL_FONT_SIZE,
    Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(fontSize)),
  );
}

export interface TerminalKeyMapping {
  enterKey: "cr" | "lf" | "crlf";
  backspaceKey: "del" | "bs";
}

interface TerminalKeyEvent {
  type: string;
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
}

interface ResettableTerminal {
  focus(): void;
  reset(): void;
  write(data: string): void;
}

interface UnicodeTerminal {
  loadAddon(addon: ITerminalAddon): void;
  unicode: {
    activeVersion: string;
  };
}

export function installUnicode11(terminal: UnicodeTerminal): Unicode11Addon {
  const addon = new Unicode11Addon();
  terminal.loadAddon(addon);
  terminal.unicode.activeVersion = "11";
  return addon;
}

export function isTerminalCompletionTab(event: TerminalKeyEvent): boolean {
  return (
    event.type === "keydown" &&
    event.key === "Tab" &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.isComposing
  );
}

/**
 * xterm 6 keeps processing `keypress` events even when a custom keydown
 * handler already consumed the key, so Enter (charCode 13) would be sent
 * twice on serial links. Suppress keypress events for keys that the
 * keydown handler transmits itself.
 */
export function isDuplicateSpecialKeyPress(
  event: TerminalKeyEvent,
): boolean {
  return (
    event.type === "keypress" &&
    (event.key === "Enter" ||
      event.key === "Tab" ||
      event.key === "Backspace")
  );
}

export function mapTerminalSpecialKey(
  event: TerminalKeyEvent,
  mapping: TerminalKeyMapping,
): string | null {
  if (
    event.type !== "keydown" ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.isComposing
  ) {
    return null;
  }
  if (event.key === "Backspace") {
    return mapping.backspaceKey === "bs" ? "\b" : "\u007f";
  }
  if (event.key === "Enter") {
    if (mapping.enterKey === "lf") return "\n";
    if (mapping.enterKey === "crlf") return "\r\n";
    return "\r";
  }
  return null;
}

export function resetTerminal(
  terminal: ResettableTerminal,
  mode: TerminalResetMode,
): void {
  if (mode === "soft") {
    terminal.write(DEC_SOFT_RESET_SEQUENCE);
  } else {
    terminal.reset();
  }
  terminal.focus();
}
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { ITerminalAddon } from "@xterm/xterm";
