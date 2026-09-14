import { appendReceiveChunk } from "./receive";
import type { ReceiveChunk } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CONTROL_START = encoder.encode("\x1bP1000p");
export const MAX_TMUX_LINE_BYTES = 1024 * 1024;
export const MAX_TMUX_BLOCK_BYTES = 4 * 1024 * 1024;
export const MAX_TMUX_PANE_BYTES = 256 * 1024;
export const MAX_TMUX_PANES = 128;
const MAX_COMMANDS = 256;
const COMMAND_TIMEOUT_MS = 30_000;

export interface TmuxWindow {
  id: string;
  index: number;
  name: string;
  width: number;
  height: number;
  active: boolean;
}

export interface TmuxPane {
  id: string;
  windowId: string;
  title: string;
  width: number;
  height: number;
  left: number;
  top: number;
  active: boolean;
  cursorX: number;
  cursorY: number;
  alternateScreen: boolean;
  cursorVisible: boolean;
  receiveChunks: ReceiveChunk[];
  receivedBytes: number;
  /** Changes when capture-pane replaces the screen; consumers must reset xterm. */
  outputRevision: number;
}

export interface TmuxSnapshot {
  active: boolean;
  sessionId?: string;
  sessionName: string;
  activeWindowId?: string;
  windows: TmuxWindow[];
  panes: TmuxPane[];
  error?: string;
}

export const EMPTY_TMUX_SNAPSHOT: TmuxSnapshot = {
  active: false,
  sessionName: "",
  windows: [],
  panes: [],
};

export interface TmuxClientOptions {
  /** A complete, LF-terminated control command, never arbitrary terminal input. */
  send: (command: string) => Promise<void>;
  /** Ordinary shell bytes before attachment and after the terminating ST. */
  onData: (bytes: Uint8Array) => void;
  onError: (message: string) => void;
}

interface Command {
  text: string;
  complete?: (lines: Uint8Array[]) => void;
  firstResponse?: (lines: Uint8Array[]) => void;
  responseError?: Error;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface Guard {
  identity: string;
  command?: Command;
  lines: Uint8Array[];
  bytes: number;
  overflow: boolean;
}

/** Decode the wire bytes directly: UTF-8 characters may span separate output events. */
export function decodeTmuxOutput(bytes: Uint8Array): Uint8Array {
  return decodeEscapes(bytes, false);
}

function decodeEscapes(bytes: Uint8Array, capture: boolean): Uint8Array {
  const result = new Uint8Array(bytes.length);
  let length = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (capture && bytes[index] === 0x5c && bytes[index + 1] === 0x5c) {
      result[length++] = 0x5c;
      index += 1;
      continue;
    }
    if (
      bytes[index] === 0x5c &&
      index + 3 < bytes.length &&
      bytes[index + 1] >= 0x30 && bytes[index + 1] <= 0x33 &&
      bytes[index + 2] >= 0x30 && bytes[index + 2] <= 0x37 &&
      bytes[index + 3] >= 0x30 && bytes[index + 3] <= 0x37
    ) {
      result[length++] = (bytes[index + 1] - 0x30) * 64 +
        (bytes[index + 2] - 0x30) * 8 + bytes[index + 3] - 0x30;
      index += 3;
    } else {
      result[length++] = bytes[index];
    }
  }
  return result.slice(0, length);
}

// q: escapes shell metacharacters, including literal tab/newline, with a backslash.
// Split the whole response, not individual lines, to preserve names containing them.
function metadataRows(lines: Uint8Array[]): string[][] {
  const text = lines.map((line) => decoder.decode(line)).join("\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\" && index + 1 < text.length) {
      field += text[++index];
    } else if (character === "\t" || character === "\n") {
      row.push(field);
      field = "";
      if (character === "\n") {
        rows.push(row);
        row = [];
      }
    } else {
      field += character;
    }
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

const PANE_FORMAT = [
  "session_id", "q:session_name", "window_id", "window_index", "q:window_name",
  "window_width", "window_height", "window_active", "pane_id", "q:pane_title",
  "pane_width", "pane_height", "pane_left", "pane_top", "pane_active",
  "cursor_x", "cursor_y", "alternate_on", "cursor_flag",
].map((name) => `#{${name}}`).join("\t");

/** One physical SSH/PTY connection owns one client. No tmux server is started here. */
export class TmuxClient {
  private snapshot: TmuxSnapshot = EMPTY_TMUX_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private readonly outputListeners = new Set<(paneId: string, bytes: Uint8Array, outputRevision: number) => void>();
  private mode: "shell" | "control" | "exiting" = "shell";
  private startPrefix: number[] = [];
  private line: number[] = [];
  private droppingLine = false;
  private exitEscape = false;
  private exitBytes = 0;
  private guard?: Guard;
  private commands: Command[] = [];
  private inFlight?: Command;
  private commandTimer?: ReturnType<typeof setTimeout>;
  private stalled = false;
  private disposed = false;
  private detaching = false;
  private refreshScheduled = false;
  private refreshing = false;
  private refreshAgain = false;
  private generation = 0;
  private sequence = 0;
  private captureRevision = 0;
  private capturePending = new Set<string>();
  private size?: { cols: number; rows: number };
  private inputTail?: Promise<void>;
  private queuedInputBytes = 0;

  constructor(private readonly options: TmuxClientOptions) {}

  getSnapshot = (): TmuxSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Subscribe to every byte, including data that arrives faster than React renders. */
  subscribeOutput = (listener: (paneId: string, bytes: Uint8Array, outputRevision: number) => void): (() => void) => {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  };

  clearError = (): void => {
    if (this.snapshot.error) this.publish({ ...this.snapshot, error: undefined });
  };

  feed(bytes: Uint8Array): void {
    if (this.disposed || bytes.length === 0) return;
    let shell: number[] = [];
    const flushShell = () => {
      if (shell.length) this.options.onData(Uint8Array.from(shell));
      shell = [];
    };
    for (const byte of bytes) {
      if (this.mode === "shell") {
        this.startPrefix.push(byte);
        while (this.startPrefix.length && !this.startPrefix.every(
          (value, index) => value === CONTROL_START[index],
        )) {
          shell.push(this.startPrefix.shift()!);
        }
        if (this.startPrefix.length === CONTROL_START.length) {
          flushShell();
          this.startPrefix = [];
          this.enterControl();
        }
      } else if (this.mode === "exiting") {
        this.exitBytes += 1;
        if (this.exitEscape && byte === 0x5c) {
          this.mode = "shell";
          this.exitEscape = false;
        } else {
          this.exitEscape = byte === 0x1b;
          if (this.exitBytes > MAX_TMUX_LINE_BYTES) {
            this.report("tmux control mode did not terminate with ST");
            this.mode = "shell";
          }
        }
      } else if (byte === 0x0a) {
        if (!this.droppingLine) {
          if (this.line.at(-1) === 0x0d) this.line.pop();
          this.processLine(Uint8Array.from(this.line));
        }
        this.line = [];
        this.droppingLine = false;
      } else if (!this.droppingLine) {
        if (this.line.length >= MAX_TMUX_LINE_BYTES) {
          this.line = [];
          this.droppingLine = true;
          if (this.guard) this.guard.overflow = true;
          this.report("tmux control line exceeded the buffer limit");
        } else {
          this.line.push(byte);
        }
      }
    }
    flushShell();
  }

  async input(bytes: Uint8Array, paneId?: string): Promise<void> {
    this.ensureActive();
    const target = this.paneTarget(paneId);
    if (!bytes.length) return;
    if (this.queuedInputBytes + bytes.length > MAX_TMUX_BLOCK_BYTES) throw new Error("tmux input queue is full");
    const copy = bytes.slice();
    this.queuedInputBytes += copy.length;
    const generation = this.generation;
    const write = async () => {
      try {
        if (this.generation !== generation) throw new Error("tmux connection changed before input was sent");
        // Serialize whole pastes so a later Enter cannot run halfway through one.
        for (let offset = 0; offset < copy.length; offset += 256) {
          if (this.generation !== generation) throw new Error("tmux connection changed before input was sent");
          this.paneTarget(target);
          const hex = Array.from(copy.subarray(offset, offset + 256),
            (byte) => byte.toString(16).padStart(2, "0")).join(" ");
          await this.command(`send-keys -H -t ${target} ${hex}`);
        }
      } finally {
        this.queuedInputBytes -= copy.length;
      }
    };
    const pending = this.inputTail ? this.inputTail.catch(() => undefined).then(write) : write();
    this.inputTail = pending;
    const clear = () => { if (this.inputTail === pending) this.inputTail = undefined; };
    void pending.then(clear, clear);
    return pending;
  }

  async resize(cols: number, rows: number): Promise<void> {
    const next = {
      cols: Math.max(1, Math.min(10_000, Math.trunc(cols))),
      rows: Math.max(1, Math.min(10_000, Math.trunc(rows))),
    };
    if (!Number.isFinite(next.cols) || !Number.isFinite(next.rows)) return;
    if (this.size?.cols === next.cols && this.size.rows === next.rows) return;
    this.size = next;
    if (this.snapshot.active) {
      await this.command(`refresh-client -C ${next.cols},${next.rows}`);
    }
  }

  async selectPane(paneId: string): Promise<void> {
    await this.command(`select-pane -t ${this.paneTarget(paneId)}`);
    this.scheduleRefresh();
  }

  async selectWindow(windowId: string): Promise<void> {
    if (!/^@\d+$/.test(windowId) || !this.snapshot.windows.some((window) => window.id === windowId)) {
      throw new Error("Unknown tmux window");
    }
    await this.command(`select-window -t ${windowId}`);
    this.scheduleRefresh();
  }

  async newWindow(): Promise<void> {
    await this.command("new-window");
    this.scheduleRefresh();
  }

  async splitWindow(direction: "horizontal" | "vertical", paneId?: string): Promise<void> {
    await this.command(`split-window ${direction === "horizontal" ? "-h" : "-v"} -t ${this.paneTarget(paneId)}`);
    this.scheduleRefresh();
  }

  async detach(): Promise<void> {
    const detached = this.command("detach-client");
    this.detaching = true;
    try { await detached; } catch (error) {
      this.detaching = false;
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.mode === "shell" && this.startPrefix.length) {
      this.options.onData(Uint8Array.from(this.startPrefix));
    }
    this.disposed = true;
    this.generation += 1;
    this.rejectCommands(new Error("tmux connection closed"));
    this.line = [];
    this.startPrefix = [];
    this.guard = undefined;
    this.capturePending.clear();
    this.publish(EMPTY_TMUX_SNAPSHOT);
    this.listeners.clear();
    this.outputListeners.clear();
  }

  private publish(snapshot: TmuxSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private report(message: string): void {
    if (this.disposed) return;
    if (this.snapshot.error === message) return;
    this.publish({ ...this.snapshot, error: message });
    this.options.onError(message);
  }

  private ensureActive(): void {
    if (!this.snapshot.active || this.disposed) throw new Error("tmux control mode is not active");
    if (this.detaching) throw new Error("tmux client is detaching");
    if (this.stalled) throw new Error("tmux control channel is unresponsive; reconnect to retry");
  }

  private paneTarget(paneId?: string): string {
    this.ensureActive();
    const pane = paneId
      ? this.snapshot.panes.find((entry) => entry.id === paneId)
      : this.snapshot.panes.find((entry) => entry.windowId === this.snapshot.activeWindowId && entry.active);
    if (!pane || !/^%\d+$/.test(pane.id)) throw new Error("No active tmux pane is available");
    return pane.id;
  }

  private enterControl(): void {
    this.mode = "control";
    this.generation += 1;
    this.stalled = false;
    this.detaching = false;
    this.refreshScheduled = false;
    this.refreshing = false;
    this.refreshAgain = false;
    this.capturePending.clear();
    this.publish({ ...EMPTY_TMUX_SNAPSHOT, active: true });
    this.scheduleRefresh();
    if (this.size) {
      this.background(this.command(`refresh-client -C ${this.size.cols},${this.size.rows}`));
    }
  }

  private leaveControl(): void {
    this.mode = "exiting";
    this.exitEscape = false;
    this.exitBytes = 0;
    this.generation += 1;
    this.rejectCommands(new Error("tmux client detached"));
    this.guard = undefined;
    this.capturePending.clear();
    this.publish(EMPTY_TMUX_SNAPSHOT);
  }

  private processLine(line: Uint8Array): void {
    // Decode headers only. Pane output remains bytes, including partial UTF-8.
    const text = decoder.decode(line);
    const guard = /^%(begin|end|error) (\d+ \d+ \d+)$/.exec(text);
    if (this.guard) {
      if (guard && guard[1] !== "begin" && guard[2] === this.guard.identity) {
        const block = this.guard;
        this.guard = undefined;
        const command = block.command === this.inFlight ? block.command : undefined;
        const failure = block.overflow
          ? "tmux command response exceeded the buffer limit"
          : guard[1] === "error"
            ? block.lines.map((entry) => decoder.decode(entry)).join("\n") || "tmux command failed"
            : undefined;
        if (command && (!command.firstResponse || failure)) {
          this.inFlight = undefined;
          clearTimeout(this.commandTimer);
        }
        if (failure) {
          if (command) command.reject(new Error(failure));
          else this.report(failure);
        } else if (command) {
          if (command.firstResponse) {
            const firstResponse = command.firstResponse;
            command.firstResponse = undefined;
            try { firstResponse(block.lines); } catch (error) {
              command.responseError = error instanceof Error ? error : new Error(String(error));
            }
          } else {
            try {
              if (command.responseError) throw command.responseError;
              command.complete?.(block.lines);
              command.resolve();
            } catch (error) {
              command.reject(error instanceof Error ? error : new Error(String(error)));
            }
          }
        }
        this.pumpCommands();
      } else {
        // Notifications never interrupt a guard block. Captured terminal text may
        // itself start with %output, %exit, or an unrelated guard-shaped line.
        this.guard.bytes += line.length + 1;
        if (this.guard.bytes > MAX_TMUX_BLOCK_BYTES) this.guard.overflow = true;
        if (!this.guard.overflow) this.guard.lines.push(line);
      }
      return;
    }
    if (guard) {
      if (guard[1] === "begin") {
        const flags = Number(guard[2].split(" ")[2]);
        this.guard = {
          identity: guard[2],
          command: (flags & 1) !== 0 ? this.inFlight : undefined,
          lines: [], bytes: 0, overflow: false,
        };
      } else {
        this.report("Unexpected tmux command guard");
      }
      return;
    }
    if (/^%exit(?: |$)/.test(text)) {
      this.leaveControl();
      return;
    }
    // The prefix contains ASCII only, so its string length is the byte offset.
    const output = /^%output (%\d+) /.exec(text) ?? /^%extended-output (%\d+) [^:]*: /.exec(text);
    if (output) {
      this.appendPaneOutput(output[1], decodeTmuxOutput(line.subarray(output[0].length)));
      return;
    }
    const session = /^%session-changed (\$\d+) (.*)$/.exec(text);
    if (session) {
      const changed = this.snapshot.sessionId !== undefined && this.snapshot.sessionId !== session[1];
      if (changed) this.capturePending.clear();
      this.publish({
        ...this.snapshot, sessionId: session[1], sessionName: session[2],
        ...(changed ? { windows: [], panes: [], activeWindowId: undefined } : {}),
      });
      this.scheduleRefresh();
      return;
    }
    const pane = /^%window-pane-changed (@\d+) (%\d+)$/.exec(text);
    if (pane) {
      this.publish({ ...this.snapshot, panes: this.snapshot.panes.map((entry) =>
        entry.windowId === pane[1] ? { ...entry, active: entry.id === pane[2] } : entry) });
      this.scheduleRefresh();
      return;
    }
    const window = /^%session-window-changed (\$\d+) (@\d+)$/.exec(text);
    if (window && (!this.snapshot.sessionId || window[1] === this.snapshot.sessionId)) {
      this.publish({ ...this.snapshot, activeWindowId: window[2], windows: this.snapshot.windows.map((entry) =>
        ({ ...entry, active: entry.id === window[2] })) });
      this.scheduleRefresh();
      return;
    }
    if (/^%(?:window-add|window-close|window-renamed|layout-change|session-renamed|sessions-changed|pane-mode-changed)(?: |$)/.test(text)) {
      this.scheduleRefresh();
    }
  }

  private command(text: string, complete?: Command["complete"], firstResponse?: Command["firstResponse"]): Promise<void> {
    try { this.ensureActive(); } catch (error) { return Promise.reject(error); }
    if (this.commands.length >= MAX_COMMANDS) return Promise.reject(new Error("tmux command queue is full"));
    return new Promise((resolve, reject) => {
      this.commands.push({ text, complete, firstResponse, resolve, reject });
      this.pumpCommands();
    });
  }

  private pumpCommands(): void {
    if (this.inFlight || this.guard || this.stalled || !this.snapshot.active || this.disposed) return;
    const command = this.commands.shift();
    if (!command) return;
    this.inFlight = command;
    const fail = (error: unknown) => {
      if (this.inFlight !== command || this.disposed) return;
      // A late response must never be assigned to a different command.
      this.stalled = true;
      const failure = error instanceof Error ? error : new Error(String(error));
      this.rejectCommands(failure);
      this.report(failure.message);
    };
    this.commandTimer = setTimeout(() => fail(new Error("tmux command timed out; reconnect to retry")), COMMAND_TIMEOUT_MS);
    try {
      void this.options.send(`${command.text}\n`).catch(fail);
    } catch (error) { fail(error); }
  }

  private rejectCommands(error: Error): void {
    clearTimeout(this.commandTimer);
    this.inFlight?.reject(error);
    for (const command of this.commands) command.reject(error);
    this.inFlight = undefined;
    this.commands = [];
  }

  private background(promise: Promise<void>): void {
    const generation = this.generation;
    void promise.catch((error: unknown) => {
      if (this.snapshot.active && this.generation === generation && !this.disposed) {
        this.report(error instanceof Error ? error.message : String(error));
      }
    });
  }

  private scheduleRefresh(): void {
    if (!this.snapshot.active || this.disposed || this.stalled) return;
    if (this.refreshing) { this.refreshAgain = true; return; }
    if (this.refreshScheduled) return;
    this.refreshScheduled = true;
    const generation = this.generation;
    queueMicrotask(() => {
      if (!this.snapshot.active || this.disposed || this.generation !== generation) return;
      this.refreshScheduled = false;
      this.refreshing = true;
      this.background(this.command(`list-panes -s -F '${PANE_FORMAT}'`, (lines) => {
        if (this.generation === generation) this.applyMetadata(lines);
      }).finally(() => {
        if (this.generation !== generation) return;
        this.refreshing = false;
        if (this.refreshAgain) {
          this.refreshAgain = false;
          this.scheduleRefresh();
        }
      }));
    });
  }

  private applyMetadata(lines: Uint8Array[]): void {
    const windows = new Map<string, TmuxWindow>();
    const panes: TmuxPane[] = [];
    let sessionId = this.snapshot.sessionId;
    let sessionName = this.snapshot.sessionName;
    for (const row of metadataRows(lines)) {
      if (row.length !== 19 || !/^\$\d+$/.test(row[0]) || !/^@\d+$/.test(row[2]) || !/^%\d+$/.test(row[8])) continue;
      if (![3, 5, 6, 7, 10, 11, 12, 13, 14, 15, 16, 17, 18].every((index) => /^\d+$/.test(row[index]))) continue;
      if (panes.length >= MAX_TMUX_PANES) {
        this.report(`tmux supports up to ${MAX_TMUX_PANES} visible panes`);
        break;
      }
      sessionId = row[0];
      sessionName = row[1];
      const size = (index: number) => Math.max(1, Math.min(10_000, Number(row[index])));
      const position = (index: number) => Math.min(10_000, Number(row[index]));
      windows.set(row[2], {
        id: row[2], index: Number(row[3]), name: row[4],
        width: size(5), height: size(6), active: row[7] === "1",
      });
      const existing = this.snapshot.panes.find((pane) => pane.id === row[8]);
      const pane: TmuxPane = {
        id: row[8], windowId: row[2], title: row[9], width: size(10), height: size(11),
        left: position(12), top: position(13), active: row[14] === "1",
        cursorX: position(15), cursorY: position(16), alternateScreen: row[17] === "1", cursorVisible: row[18] === "1",
        receiveChunks: existing?.receiveChunks ?? [], receivedBytes: existing?.receivedBytes ?? 0,
        outputRevision: existing?.outputRevision ?? 0,
      };
      panes.push(existing && Object.keys(pane).every((key) =>
        pane[key as keyof TmuxPane] === existing[key as keyof TmuxPane]) ? existing : pane);
    }
    if (lines.length && !panes.length) throw new Error("Invalid tmux pane metadata response");
    const orderedWindows = [...windows.values()].sort((a, b) => a.index - b.index);
    this.publish({ ...this.snapshot, sessionId, sessionName, windows: orderedWindows, panes,
      activeWindowId: orderedWindows.find((window) => window.active)?.id ?? orderedWindows[0]?.id });
    for (const pane of panes) {
      if (pane.outputRevision === 0 && !this.capturePending.has(pane.id)) this.capturePane(pane);
    }
  }

  private capturePane(pane: TmuxPane): void {
    this.capturePending.add(pane.id);
    const generation = this.generation;
    const sessionId = this.snapshot.sessionId;
    const stateFormats = [
      "cursor_x", "cursor_y", "alternate_on", "cursor_flag", "keypad_cursor_flag", "keypad_flag",
      "mouse_standard_flag", "mouse_button_flag", "mouse_any_flag", "mouse_utf8_flag", "mouse_sgr_flag", "bracketed_paste_flag",
    ].map((name) => `#{${name}}`).join(",");
    let cursorX = pane.cursorX;
    let cursorY = pane.cursorY;
    let alternateScreen = pane.alternateScreen;
    let cursorVisible = pane.cursorVisible;
    let modes = "";
    // A single tmux command sequence runs both operations in the same server
    // command queue turn. Cursor/modes therefore describe the captured screen,
    // rather than an earlier list-panes result while the process was still busy.
    const command = `display-message -p -t ${pane.id} '${stateFormats}' ; capture-pane -p -e -C -S -2000 -t ${pane.id}`;
    this.background(this.command(command, (lines) => {
      if (this.generation !== generation || this.snapshot.sessionId !== sessionId) return;
      const current = this.snapshot.panes.find((entry) => entry.id === pane.id);
      if (!current) return;
      const parts = lines.map((line) => decodeEscapes(line, true));
      const prefix = encoder.encode(`\x1b[0m${alternateScreen ? "\x1b[?1049h" : ""}\x1b[H`);
      const suffix = encoder.encode(`\x1b[${cursorY + 1};${cursorX + 1}H\x1b[?25${cursorVisible ? "h" : "l"}${modes}`);
      const length = prefix.length + suffix.length + parts.reduce((total, part) => total + part.length, 0) + Math.max(0, parts.length - 1) * 2;
      const bytes = new Uint8Array(length);
      bytes.set(prefix);
      let offset = prefix.length;
      parts.forEach((part, index) => {
        if (index) { bytes.set([13, 10], offset); offset += 2; }
        bytes.set(part, offset);
        offset += part.length;
      });
      bytes.set(suffix, offset);
      // Apply synchronously at %end, before any subsequent %output in this feed.
      const outputRevision = ++this.captureRevision;
      this.publish({ ...this.snapshot, panes: this.snapshot.panes.map((entry) => entry.id === pane.id
        ? { ...entry, receiveChunks: [], receivedBytes: 0, outputRevision } : entry) });
      this.appendPaneOutput(pane.id, bytes);
    }, (lines) => {
      const state = decoder.decode(lines[0]).split(",");
      if (state.length < 4 || !state.slice(0, 4).every((field) => /^\d+$/.test(field))) {
        throw new Error("Invalid tmux capture cursor response");
      }
      cursorX = Math.max(0, Math.min(pane.width - 1, Number(state[0])));
      cursorY = Math.max(0, Math.min(pane.height - 1, Number(state[1])));
      alternateScreen = state[2] === "1";
      cursorVisible = state[3] === "1";
      if (state.length >= 12) {
        modes = `\x1b[?1${state[4] === "1" ? "h" : "l"}\x1b${state[5] === "1" ? "=" : ">"}`;
        [1000, 1002, 1003, 1005, 1006, 2004].forEach((mode, index) => {
          modes += `\x1b[?${mode}${state[index + 6] === "1" ? "h" : "l"}`;
        });
      }
    }).finally(() => {
      if (this.generation === generation) this.capturePending.delete(pane.id);
    }));
  }

  private appendPaneOutput(paneId: string, bytes: Uint8Array): void {
    if (!bytes.length) return;
    let pane = this.snapshot.panes.find((entry) => entry.id === paneId);
    if (!pane) {
      // Output can precede the first list-panes response. Keep it until capture.
      if (this.snapshot.panes.length >= MAX_TMUX_PANES) return;
      pane = {
        id: paneId, windowId: "", title: paneId, width: 80, height: 24, left: 0, top: 0,
        active: false, cursorX: 0, cursorY: 0, alternateScreen: false, cursorVisible: true,
        receiveChunks: [], receivedBytes: 0, outputRevision: 0,
      };
      this.snapshot = { ...this.snapshot, panes: [...this.snapshot.panes, pane] };
      this.scheduleRefresh();
    }
    const sequence = ++this.sequence;
    const next = {
      ...pane, receivedBytes: pane.receivedBytes + bytes.length,
      receiveChunks: appendReceiveChunk(pane.receiveChunks, {
        nonce: sequence, sequence, receivedAtMs: Date.now(), bytes: Array.from(bytes),
      }, MAX_TMUX_PANE_BYTES),
    };
    this.publish({ ...this.snapshot, panes: this.snapshot.panes.map((entry) => entry.id === paneId ? next : entry) });
    for (const listener of this.outputListeners) listener(paneId, bytes, next.outputRevision);
  }
}
