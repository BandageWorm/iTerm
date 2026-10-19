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

export type CompletionAcceptAction =
  /** 用户已显式选中候选，把剩余字符补齐到输入行。 */
  | { kind: "accept"; remainder: string }
  /** 没有可接受的选择，按键交给会话。 */
  | { kind: "passthrough" };

/**
 * 候选能否把输入行再往后补一截。与输入完全一致（或不是前缀）的候选
 * 补不出任何字符，选中它们再按接受键只会让用户以为键失灵。
 */
export function canCompleteFromBuffer(
  command: string,
  buffer: string,
): boolean {
  return (
    command.toLocaleLowerCase().startsWith(buffer.toLocaleLowerCase()) &&
    command.length > buffer.length
  );
}

export interface CompletionAcceptInput {
  /** 用户用方向键选中的候选下标，未选中为 -1。 */
  selectedIndex: number;
  /** 当前输入行的影子缓冲。 */
  buffer: string;
  suggestions: readonly { command: string }[];
}

/**
 * 联想只在用户显式选中候选后接受按键（回车）。Tab 不属于联想，
 * 始终交给会话，shell 与串口设备都能拿到自己的补全键。
 */
export function resolveCompletionAcceptAction({
  selectedIndex,
  buffer,
  suggestions,
}: CompletionAcceptInput): CompletionAcceptAction {
  if (selectedIndex < 0) return { kind: "passthrough" };
  const suggestion = suggestions[selectedIndex];
  if (!suggestion) return { kind: "passthrough" };
  const command = suggestion.command;
  if (canCompleteFromBuffer(command, buffer)) {
    return { kind: "accept", remainder: command.slice(buffer.length) };
  }
  return { kind: "passthrough" };
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
