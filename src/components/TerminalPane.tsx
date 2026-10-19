import {
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Clock3,
  Command as CommandIcon,
  Copy,
  ScanText,
  Search,
  SendHorizontal,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { formatHexDump, timestampReceivedText } from "../lib/receive";
import {
  resolveCompletionPlacement,
  type CompletionPlacement,
} from "../lib/completionPlacement";
import { resolveRightClickAction } from "../lib/terminalInteraction";
import type { ResolvedTheme } from "../lib/preferences";
import {
  installUnicode11,
  canCompleteFromBuffer,
  clampTerminalFontSize,
  DEFAULT_TERMINAL_FONT_SIZE,
  isDuplicateSpecialKeyPress,
  isTerminalCompletionTab,
  MAX_TERMINAL_FONT_SIZE,
  mapTerminalSpecialKey,
  MIN_TERMINAL_FONT_SIZE,
  resolveCompletionAcceptAction,
  TERMINAL_CONVERT_EOL,
} from "../lib/terminal";
import type {
  ReceiveMode,
  RuntimeSession,
  SessionProfile,
} from "../lib/types";
import { sessionTargetLabel } from "../lib/types";
import { useI18n } from "../lib/i18n";
import {
  executeTerminalCommand,
  clampContextMenuPosition,
  requestTerminalSearch,
  TERMINAL_COMMAND_EVENT,
  TERMINAL_SEARCH_EVENT,
  type TerminalSearchRequest,
  type TerminalUiCommand,
} from "../lib/uiCommands";
import {
  buildCommandSuggestions,
  commandLineEnding,
  consumeTerminalInput,
  loadCommandHistory,
  recordCommand,
  type CommandHistoryEntry,
  type CommandSuggestion,
} from "../lib/commandHistory";
import {
  hasQuickCommandPayload,
  loadQuickCommands,
  type QuickCommand,
} from "../lib/quickCommands";
import { colorizeSerialText } from "../lib/serialColors";
import { resolveTerminalTheme } from "../lib/terminalTheme";

interface TerminalPaneProps {
  session: RuntimeSession;
  profile: SessionProfile;
  active: boolean;
  visible: boolean;
  receiveMode: ReceiveMode;
  theme: ResolvedTheme;
  rightClickCopyPaste: boolean;
  showHistory: boolean;
  onActivate: () => void;
  onResize: (cols: number, rows: number) => void;
  onClear: () => void;
  onInput: (value: string) => void;
  onFontSizeChange: (fontSize: number) => void;
  onCollectQuickCommand: (command: string) => void;
}

export function TerminalPane({
  session,
  profile,
  active,
  visible,
  receiveMode,
  theme,
  rightClickCopyPaste,
  showHistory,
  onActivate,
  onResize,
  onClear,
  onInput,
  onFontSizeChange,
  onCollectQuickCommand,
}: TerminalPaneProps) {
  const { locale, t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const commandInputRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef(onInput);
  const trackedInputRef = useRef(onInput);
  const resizeRef = useRef(onResize);
  const fontSizeRef = useRef(profile.terminal.fontSize);
  const fontSizeChangeRef = useRef(onFontSizeChange);
  const decoderRef = useRef<TextDecoder | null>(null);
  const lastWrittenNonceRef = useRef<number | null>(null);
  const startsNewLineRef = useRef(true);
  const typedCommandRef = useRef("");
  const inlineSuggestionsRef = useRef<CommandSuggestion[]>([]);
  const completableIndexesRef = useRef<number[]>([]);
  const activeInlineSuggestionRef = useRef(-1);
  const searchRequestRef = useRef(0);
  const searchSourceRef = useRef<object>({});
  const [completionBox, setCompletionBox] = useState<{
    placement: CompletionPlacement;
    top: number | null;
    bottom: number | null;
    maxHeight: number;
  } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchFound, setSearchFound] = useState<boolean | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandValue, setCommandValue] = useState("");
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [liveCommandValue, setLiveCommandValue] = useState("");
  const [inlineCompletionDismissed, setInlineCompletionDismissed] = useState(false);
  const [activeInlineSuggestion, setActiveInlineSuggestion] = useState(-1);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    hasSelection: boolean;
  } | null>(null);
  const [commandHistory, setCommandHistory] = useState<CommandHistoryEntry[]>(
    () => loadCommandHistory(profile.id),
  );
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>(() =>
    loadQuickCommands(),
  );
  const commandSuggestions = useMemo(
    () =>
      buildCommandSuggestions(
        commandValue,
        commandHistory,
        quickCommands,
      ),
    [commandHistory, commandValue, quickCommands],
  );
  const inlineSuggestions = useMemo(
    () =>
      inlineCompletionDismissed || !liveCommandValue.trim()
        ? []
        : buildCommandSuggestions(
            liveCommandValue,
            commandHistory,
            quickCommands,
            7,
          ),
    [
      commandHistory,
      inlineCompletionDismissed,
      liveCommandValue,
      quickCommands,
    ],
  );
  // 只有能把输入行再补一截的候选才允许被选中，否则 Tab 会"选中了却没反应"。
  const completableIndexes = useMemo(
    () =>
      inlineSuggestions.flatMap((suggestion, index) =>
        canCompleteFromBuffer(suggestion.command, liveCommandValue)
          ? [index]
          : [],
      ),
    [inlineSuggestions, liveCommandValue],
  );
  const hexDump = useMemo(
    () =>
      receiveMode === "hex"
        ? formatHexDump(
            session.receiveChunks,
            session.bytesRead - session.receiveBaseOffset,
            profile.terminal.hexColumns,
            undefined,
            profile.terminal.timestamp,
            profile.terminal.hexGroupSize,
          )
        : { text: "", omittedBytes: 0 },
    [
      profile.terminal.hexColumns,
      profile.terminal.hexGroupSize,
      profile.terminal.timestamp,
      receiveMode,
      session.receiveBaseOffset,
      session.bytesRead,
      session.receiveChunks,
    ],
  );

  inputRef.current = onInput;
  trackedInputRef.current = (value: string) => {
    const next = consumeTerminalInput(typedCommandRef.current, value);
    typedCommandRef.current = next.buffer;
    setLiveCommandValue(next.buffer);
    if (
      [...value].some(
        (character) =>
          character === "\b" ||
          character === "\u007f" ||
          character >= " ",
      )
    ) {
      setInlineCompletionDismissed(false);
      setActiveInlineSuggestion(-1);
    }
    if (next.completed.length > 0) {
      let history = commandHistory;
      for (const command of next.completed) {
        history = recordCommand(profile.id, command);
      }
      setCommandHistory(history);
      setInlineCompletionDismissed(false);
      setActiveInlineSuggestion(-1);
    }
    inputRef.current(value);
  };
  inlineSuggestionsRef.current = inlineSuggestions;
  completableIndexesRef.current = completableIndexes;
  activeInlineSuggestionRef.current = activeInlineSuggestion;
  resizeRef.current = onResize;
  fontSizeRef.current = profile.terminal.fontSize;
  fontSizeChangeRef.current = onFontSizeChange;

  const changeTerminalFontSize = (requestedSize: number) => {
    const fontSize = clampTerminalFontSize(requestedSize);
    if (fontSize === fontSizeRef.current) return;
    fontSizeRef.current = fontSize;
    fontSizeChangeRef.current(fontSize);
    window.setTimeout(() => terminalRef.current?.focus(), 0);
  };

  const refreshCommandSources = () => {
    setCommandHistory(loadCommandHistory(profile.id));
    setQuickCommands(loadQuickCommands());
  };

  const openCommandComposer = () => {
    refreshCommandSources();
    setCommandOpen(true);
    setActiveSuggestion(-1);
    window.setTimeout(() => commandInputRef.current?.focus(), 0);
  };

  const openHistoryCommand = (command: string) => {
    refreshCommandSources();
    setCommandValue(command);
    setActiveSuggestion(-1);
    setCommandOpen(true);
    window.setTimeout(() => commandInputRef.current?.focus(), 0);
  };

  const collectHistoryCommand = (command: string) => {
    onCollectQuickCommand(command);
    setQuickCommands(loadQuickCommands());
  };

  const submitCommand = (
    suggestion = activeSuggestion >= 0
      ? commandSuggestions[activeSuggestion]
      : undefined,
  ) => {
    if (session.state !== "connected" || session.transferActive) return;
    const command = (suggestion?.command ?? commandValue).trim();
    if (!command) return;
    const ending = commandLineEnding(
      suggestion?.lineEnding ?? "terminal",
      profile.terminal.enterKey,
    );
    setCommandHistory(recordCommand(profile.id, command));
    typedCommandRef.current = "";
    setLiveCommandValue("");
    setInlineCompletionDismissed(false);
    setActiveInlineSuggestion(-1);
    inputRef.current(`${command}${ending}`);
    setCommandValue("");
    setActiveSuggestion(-1);
    window.setTimeout(() => commandInputRef.current?.focus(), 0);
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      allowProposedApi: true,
      convertEol: TERMINAL_CONVERT_EOL,
      cursorBlink: true,
      cursorStyle: profile.terminal.cursorStyle,
      fontFamily: profile.terminal.fontFamily,
      fontSize: profile.terminal.fontSize,
      lineHeight: profile.terminal.lineHeight,
      scrollback: profile.terminal.scrollback,
      tabStopWidth: 8,
      theme: resolveTerminalTheme(
        theme,
        profile.terminal.paletteMode,
        profile.terminal.customPalette,
      ),
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(search);
    installUnicode11(terminal);
    terminal.open(host);

    try {
      terminal.loadAddon(new WebglAddon());
    } catch {
      // WebGL is an optimization. The DOM/canvas renderer remains functional.
    }

    terminal.attachCustomKeyEventHandler((event) => {
      if (isDuplicateSpecialKeyPress(event)) {
        return false;
      }
      const shortcutKey = event.key.toLocaleLowerCase();
      const zoomShortcut =
        event.type === "keydown" &&
        (event.metaKey || event.ctrlKey) &&
        ["+", "=", "-", "_", "0"].includes(shortcutKey);
      if (zoomShortcut) {
        event.preventDefault();
        event.stopPropagation();
        changeTerminalFontSize(
          shortcutKey === "0"
            ? DEFAULT_TERMINAL_FONT_SIZE
            : fontSizeRef.current +
                (shortcutKey === "+" || shortcutKey === "=" ? 1 : -1),
        );
        return false;
      }
      const copyShortcut =
        (event.metaKey && shortcutKey === "c" && terminal.hasSelection()) ||
        (event.ctrlKey && event.shiftKey && shortcutKey === "c");
      const pasteShortcut =
        (event.metaKey && shortcutKey === "v") ||
        (event.ctrlKey && event.shiftKey && shortcutKey === "v");
      if (event.type === "keydown" && (copyShortcut || pasteShortcut)) {
        event.preventDefault();
        void executeTerminalCommand(
          copyShortcut ? "copy" : "paste",
          terminal,
          (value) => trackedInputRef.current(value),
        ).catch(() => undefined);
        return false;
      }
      const commandShortcut =
        (event.metaKey && shortcutKey === "k") ||
        (event.ctrlKey && event.shiftKey && shortcutKey === "k");
      if (event.type === "keydown" && commandShortcut) {
        event.preventDefault();
        openCommandComposer();
        return false;
      }
      if ((event.ctrlKey || event.metaKey) && shortcutKey === "f") {
        if (event.type === "keydown") {
          event.preventDefault();
          requestTerminalSearch({ source: searchSourceRef.current });
        }
        // Keep the keyup from returning focus to the terminal, which would
        // steal it back from the search input opened by the keydown.
        return false;
      }
      if (
        event.type === "keydown" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        inlineSuggestionsRef.current.length > 0
      ) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const candidates = completableIndexesRef.current;
          // 没有可补全的候选时把 ↑/↓ 还给 shell，历史召回不受影响。
          if (candidates.length === 0) return true;
          event.preventDefault();
          const step = event.key === "ArrowDown" ? 1 : -1;
          const position = candidates.indexOf(
            activeInlineSuggestionRef.current,
          );
          const next =
            position < 0
              ? candidates[step > 0 ? 0 : candidates.length - 1]
              : candidates[(position + step + candidates.length) % candidates.length];
          activeInlineSuggestionRef.current = next;
          setActiveInlineSuggestion(next);
          return false;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setInlineCompletionDismissed(true);
          setActiveInlineSuggestion(-1);
          return false;
        }
        // 回车负责接受联想，Tab 永远交给会话。
        if (event.key === "Enter") {
          const action = resolveCompletionAcceptAction({
            selectedIndex: activeInlineSuggestionRef.current,
            buffer: typedCommandRef.current,
            suggestions: inlineSuggestionsRef.current,
          });
          if (action.kind === "accept") {
            event.preventDefault();
            trackedInputRef.current(action.remainder);
            setActiveInlineSuggestion(-1);
            setInlineCompletionDismissed(true);
            return false;
          }
        }
      }
      if (isTerminalCompletionTab(event)) {
        // 把 Tab 交给会话的同时收起浮层：shell 随即会打印自己的补全列表，
        // 浮层留在原地正好把它盖住。
        setInlineCompletionDismissed(true);
        setActiveInlineSuggestion(-1);
        if (profile.protocol === "serial") {
          event.preventDefault();
          trackedInputRef.current("\t");
          return false;
        }
        return true;
      }
      const mappedInput = mapTerminalSpecialKey(event, profile.terminal);
      if (mappedInput !== null) {
        trackedInputRef.current(mappedInput);
        return false;
      }
      return true;
    });
    const inputDisposable = terminal.onData((value) => {
      trackedInputRef.current(value);
    });
    const dimensionsDisposable = terminal.onResize(({ cols, rows }) =>
      resizeRef.current(cols, rows),
    );
    const resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch {
          // The pane can be hidden between observation and the animation frame.
        }
      });
    });
    resizeObserver.observe(host);

    terminalRef.current = terminal;
    fitRef.current = fit;
    searchRef.current = search;
    decoderRef.current = new TextDecoder(profile.terminal.encoding, {
      fatal: false,
    });
    const replayParts: string[] = [];
    for (const chunk of session.receiveChunks) {
      const decoded = decoderRef.current.decode(new Uint8Array(chunk.bytes), {
        stream: true,
      });
      const timestamped = timestampReceivedText(
        decoded,
        chunk.receivedAtMs,
        startsNewLineRef.current,
      );
      startsNewLineRef.current = timestamped.startsNewLine;
      const text = profile.terminal.timestamp ? timestamped.text : decoded;
      const displayText =
        profile.protocol === "serial" && profile.terminal.semanticColors
          ? colorizeSerialText(text)
          : text;
      if (displayText) replayParts.push(displayText);
      lastWrittenNonceRef.current = chunk.nonce;
    }
    if (replayParts.length > 0) terminal.write(replayParts.join(""));
    terminal.focus();

    return () => {
      resizeObserver.disconnect();
      inputDisposable.dispose();
      dimensionsDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      decoderRef.current = null;
      lastWrittenNonceRef.current = null;
      startsNewLineRef.current = true;
    };
    // Receive history is intentionally replayed only when the terminal itself
    // is recreated by one of the terminal configuration dependencies below.
  }, [
    profile.terminal.cursorStyle,
    profile.terminal.encoding,
    profile.terminal.fontFamily,
    profile.terminal.fontSize,
    profile.terminal.lineHeight,
    profile.terminal.paletteMode,
    profile.terminal.customPalette,
    profile.terminal.backspaceKey,
    profile.terminal.enterKey,
    profile.terminal.scrollback,
    profile.terminal.semanticColors,
    profile.terminal.timestamp,
    profile.id,
    theme,
  ]);

  useEffect(() => {
    typedCommandRef.current = "";
    setLiveCommandValue("");
    setInlineCompletionDismissed(false);
    setActiveInlineSuggestion(-1);
    setCommandValue("");
    setActiveSuggestion(-1);
    refreshCommandSources();
  }, [profile.id]);

  useEffect(() => {
    if (!session.lastChunk || !terminalRef.current || !decoderRef.current) return;
    if (session.lastChunk.nonce === lastWrittenNonceRef.current) return;
    const decoded = decoderRef.current.decode(
      new Uint8Array(session.lastChunk.bytes),
      { stream: true },
    );
    const timestamped = timestampReceivedText(
      decoded,
      session.lastChunk.receivedAtMs,
      startsNewLineRef.current,
    );
    startsNewLineRef.current = timestamped.startsNewLine;
    const text = profile.terminal.timestamp ? timestamped.text : decoded;
    const displayText =
      profile.protocol === "serial" && profile.terminal.semanticColors
        ? colorizeSerialText(text)
        : text;
    if (displayText) {
      terminalRef.current.write(displayText);
    }
    lastWrittenNonceRef.current = session.lastChunk.nonce;
  }, [session.lastChunk]);

  useEffect(() => {
    if (!searchOpen) return;
    searchInputRef.current?.focus();
  }, [searchOpen]);

  const suggestionCount = inlineSuggestions.length;
  useEffect(() => {
    if (suggestionCount === 0) {
      setCompletionBox(null);
      return;
    }
    const terminal = terminalRef.current;
    const host = hostRef.current;
    if (!terminal || !host) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const pane = host.parentElement;
      if (!pane) return;
      const buffer = terminal.buffer.active;
      const rows = Math.max(1, terminal.rows);
      const screen = host.querySelector<HTMLElement>(".xterm-screen");
      const screenHeight =
        screen?.getBoundingClientRect().height ?? host.clientHeight;
      const hostRect = host.getBoundingClientRect();
      // 首次测量可能早于 xterm 布局完成，此时退回按宿主高度估算行高。
      const rowHeight =
        screenHeight > 0 ? screenHeight / rows : hostRect.height / rows;
      if (rowHeight <= 0) return;
      const paneRect = pane.getBoundingClientRect();
      const placement = resolveCompletionPlacement({
        rows,
        rowHeight,
        // xterm 的 cursorY 已经是视口相对行号（0 = baseY 那一行），
        // 再减 baseY 会得到负值并被夹到 0，浮层就会被误判到面板顶部。
        cursorRow: Math.min(Math.max(0, buffer.cursorY), rows - 1),
        paneHeight: hostRect.height,
      });
      const next = {
        placement: placement.placement,
        top:
          placement.placement === "below"
            ? Math.round(placement.offset + (hostRect.top - paneRect.top))
            : null,
        bottom:
          placement.placement === "above"
            ? Math.round(placement.offset + (paneRect.bottom - hostRect.bottom))
            : null,
        maxHeight: Math.round(placement.maxHeight),
      };
      setCompletionBox((current) =>
        current &&
        current.placement === next.placement &&
        current.top === next.top &&
        current.bottom === next.bottom &&
        current.maxHeight === next.maxHeight
          ? current
          : next,
      );
    };
    const schedule = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    schedule();
    // onRender 让持续输出导致的光标行变化也能即时反映到位置，
    // 否则浮层会停在一次旧测量得到的锚点上。
    const disposables = [
      terminal.onRender(schedule),
      terminal.onCursorMove(schedule),
      terminal.onResize(schedule),
      terminal.onScroll(schedule),
    ];
    const observer = new ResizeObserver(schedule);
    observer.observe(host);
    return () => {
      for (const disposable of disposables) disposable.dispose();
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [profile.terminal.fontSize, suggestionCount]);

  useEffect(() => {
    if (!visible) return;
    const frame = window.requestAnimationFrame(() => {
      fitRef.current?.fit();
      if (active && !searchOpen) terminalRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, searchOpen, visible]);

  useEffect(() => {
    if (session.state !== "connected" || !terminalRef.current) return;
    resizeRef.current(terminalRef.current.cols, terminalRef.current.rows);
  }, [session.state]);

  useEffect(() => {
    if (!visible) return;
    const openSearch = (event: Event) => {
      const detail = (event as CustomEvent<TerminalSearchRequest>).detail;
      if (typeof detail?.requestId === "number") {
        if (detail.requestId <= searchRequestRef.current) return;
        searchRequestRef.current = detail.requestId;
      }
      const shouldOpen =
        detail?.source === undefined
          ? active
          : detail.source === searchSourceRef.current;
      if (!shouldOpen || receiveMode !== "text") {
        setSearchOpen(false);
        return;
      }
      setSearchOpen(true);
    };
    window.addEventListener(TERMINAL_SEARCH_EVENT, openSearch);
    const executeCommand = (event: Event) => {
      if (!terminalRef.current) return;
      const command = (event as CustomEvent<TerminalUiCommand>).detail;
      if (command === "paste" && session.state !== "connected") return;
      void executeTerminalCommand(
        command,
        terminalRef.current,
        (value) => trackedInputRef.current(value),
      ).catch(() => undefined);
    };
    if (active) {
      window.addEventListener(TERMINAL_COMMAND_EVENT, executeCommand);
    }
    return () => {
      window.removeEventListener(TERMINAL_SEARCH_EVENT, openSearch);
      window.removeEventListener(TERMINAL_COMMAND_EVENT, executeCommand);
    };
  }, [active, receiveMode, session.state, visible]);

  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = (event: PointerEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node)) {
        setContextMenu(null);
      }
    };
    const dismissImmediately = () => setContextMenu(null);
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("blur", dismissImmediately);
    window.addEventListener("resize", dismissImmediately);
    window.addEventListener("keydown", dismissOnEscape);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("blur", dismissImmediately);
      window.removeEventListener("resize", dismissImmediately);
      window.removeEventListener("keydown", dismissOnEscape);
    };
  }, [contextMenu]);

  const find = (
    direction: "next" | "previous",
    query = searchTerm,
  ) => {
    if (!query || !searchRef.current) {
      setSearchFound(null);
      return;
    }
    const found =
      direction === "next"
        ? searchRef.current.findNext(query, {
            caseSensitive: false,
            incremental: true,
          })
        : searchRef.current.findPrevious(query, {
            caseSensitive: false,
          });
    setSearchFound(found);
  };

  const clearTerminal = () => {
    terminalRef.current?.clear();
    onClear();
    setSearchFound(null);
  };

  const runContextCommand = (command: TerminalUiCommand) => {
    if (!terminalRef.current) return;
    void executeTerminalCommand(
      command,
      terminalRef.current,
      (value) => trackedInputRef.current(value),
    ).catch(() => undefined);
    setContextMenu(null);
    terminalRef.current.focus();
  };

  return (
    <section
      className={[
        "terminal-pane",
        visible ? "is-visible" : "",
        active ? "is-active" : "",
        commandOpen ? "has-command-composer" : "",
        commandOpen && commandSuggestions.length > 0
          ? "has-command-suggestions"
          : "",
        active && showHistory ? "has-history-dock" : "",
      ].filter(Boolean).join(" ")}
      aria-label={t("terminal.label", { name: profile.name })}
      onMouseDown={onActivate}
      onContextMenu={(event) => {
        event.preventDefault();
        onActivate();
        const terminal = terminalRef.current;
        const openContextMenu = () => {
          const position = clampContextMenuPosition(
            event.clientX,
            event.clientY,
            window.innerWidth,
            window.innerHeight,
          );
          setContextMenu({
            ...position,
            hasSelection: terminal?.hasSelection() ?? false,
          });
        };
        const action = resolveRightClickAction({
          enabled: rightClickCopyPaste,
          shiftKey: event.shiftKey,
          hasSelection: terminal?.hasSelection() ?? false,
          canPaste: session.state === "connected" && !session.transferActive,
        });
        if (!terminal || action === "menu") {
          openContextMenu();
          return;
        }
        const send = (value: string) => trackedInputRef.current(value);
        if (action === "copy") {
          void executeTerminalCommand("copy", terminal, send)
            .then((copied) => {
              if (!copied) {
                openContextMenu();
                return;
              }
              terminal.clearSelection();
            })
            .catch(() => openContextMenu());
          return;
        }
        void executeTerminalCommand("paste", terminal, send)
          .then((pasted) => {
            if (!pasted) openContextMenu();
          })
          .catch(() => openContextMenu());
      }}
      onWheel={(event) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        changeTerminalFontSize(
          fontSizeRef.current + (event.deltaY < 0 ? 1 : -1),
        );
      }}
    >
      <div
        ref={hostRef}
        className={`terminal-host ${receiveMode === "text" ? "" : "is-hidden"}`}
      />
      {receiveMode === "hex" && (
        <div
          className="terminal-hex-view"
          role="region"
          aria-label={t("terminal.hexView")}
        >
          {hexDump.omittedBytes > 0 && (
            <div className="hex-omitted">
              {t("terminal.hexOmitted", {
                bytes: hexDump.omittedBytes.toLocaleString(locale),
              })}
            </div>
          )}
          <pre>{hexDump.text || t("terminal.waiting")}</pre>
        </div>
      )}
      {searchOpen && receiveMode === "text" && (
        <div className="terminal-tools">
          <div className="terminal-search">
            <Search size={14} />
            <input
              ref={searchInputRef}
              value={searchTerm}
              onChange={(event) => {
                const value = event.target.value;
                setSearchTerm(value);
                window.setTimeout(() => find("next", value), 0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  find(event.shiftKey ? "previous" : "next");
                }
                if (event.key === "Escape") {
                  setSearchOpen(false);
                  terminalRef.current?.focus();
                }
              }}
              placeholder={t("terminal.search")}
              aria-label={t("terminal.search")}
            />
            {searchFound === false && (
              <span className="search-empty">
                {t("terminal.search.empty")}
              </span>
            )}
            <button
              onClick={() => find("previous")}
              title={t("terminal.search.previous")}
            >
              <ChevronUp size={14} />
            </button>
            <button
              onClick={() => find("next")}
              title={t("terminal.search.next")}
            >
              <ChevronDown size={14} />
            </button>
            <button
              onClick={() => {
                setSearchOpen(false);
                terminalRef.current?.focus();
              }}
              title={t("terminal.search.close")}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}
      {active && !commandOpen && inlineSuggestions.length > 0 && (
        <div
          className="terminal-inline-completion"
          data-placement={completionBox?.placement ?? "above"}
          style={{
            top: completionBox?.top ?? "auto",
            bottom:
              completionBox?.bottom ?? (completionBox ? "auto" : 7),
            maxHeight: completionBox?.maxHeight,
            visibility: completionBox ? "visible" : "hidden",
          }}
          role="listbox"
          aria-label={t("terminal.command.suggestions")}
        >
          <div className="terminal-inline-completion-list">
            {inlineSuggestions.map((suggestion, index) => {
              const selectable = completableIndexes.includes(index);
              return (
                <button
                  key={suggestion.id}
                  className={[
                    selectable ? "" : "is-static",
                    index === activeInlineSuggestion ? "is-active" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  role="option"
                  aria-selected={index === activeInlineSuggestion}
                  aria-disabled={!selectable}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => openHistoryCommand(suggestion.command)}
                  onDoubleClick={() => submitCommand(suggestion)}
                >
                  {suggestion.source === "quick" ? (
                    <Zap size={13} />
                  ) : (
                    <Clock3 size={13} />
                  )}
                  <span>{suggestion.label}</span>
                  <small>
                    {suggestion.source === "quick"
                      ? t("terminal.command.quick")
                      : `${suggestion.useCount} uses`}
                  </small>
                </button>
              );
            })}
          </div>
          <footer>
            <span className="terminal-inline-completion-query">
              {liveCommandValue}
            </span>
            <kbd>↑↓</kbd>
            <span className="terminal-inline-completion-hint">
              {t("terminal.command.acceptHint")}
            </span>
          </footer>
        </div>
      )}
      {active && showHistory && (
        <aside
          className="terminal-history-dock"
          aria-label={t("terminal.history.title")}
        >
          <header>
            <Clock3 size={14} />
            <strong>{t("terminal.history.title")}</strong>
            <span>{commandHistory.length}</span>
          </header>
          <div className="terminal-history-list">
            {commandHistory.length === 0 ? (
              <p>{t("terminal.history.empty")}</p>
            ) : (
              commandHistory.slice(0, 200).map((entry) => {
                const collected = hasQuickCommandPayload(
                  quickCommands,
                  entry.command,
                );
                return (
                  <div className="terminal-history-entry" key={entry.command}>
                    <button
                      onClick={() => openHistoryCommand(entry.command)}
                      title={entry.command}
                    >
                      <code>{entry.command}</code>
                      <small>{entry.useCount} uses</small>
                    </button>
                    <button
                      className={collected ? "is-collected" : ""}
                      disabled={collected}
                      onClick={() => collectHistoryCommand(entry.command)}
                      title={
                        collected
                          ? t("quick.commands.favorited")
                          : t("quick.commands.favorite")
                      }
                      aria-label={
                        collected
                          ? t("quick.commands.favorited")
                          : t("quick.commands.favorite")
                      }
                    >
                      <Zap size={12} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </aside>
      )}
      {commandOpen && (
        <div className="command-composer">
          <div className="command-composer-input">
            <CommandIcon size={16} />
            <input
              ref={commandInputRef}
              value={commandValue}
              onFocus={refreshCommandSources}
              onChange={(event) => {
                setCommandValue(event.target.value);
                setActiveSuggestion(-1);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActiveSuggestion((current) =>
                    Math.min(commandSuggestions.length - 1, current + 1),
                  );
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveSuggestion((current) =>
                    current <= 0
                      ? Math.max(0, commandSuggestions.length - 1)
                      : current - 1,
                  );
                } else if (event.key === "Tab") {
                  const suggestion =
                    commandSuggestions[
                      activeSuggestion >= 0 ? activeSuggestion : 0
                    ];
                  if (suggestion) {
                    event.preventDefault();
                    setCommandValue(suggestion.command);
                    setActiveSuggestion(-1);
                  }
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  submitCommand();
                } else if (event.key === "Escape") {
                  setCommandOpen(false);
                  terminalRef.current?.focus();
                }
              }}
              placeholder={t("terminal.command.placeholder")}
              aria-label={t("terminal.command.input")}
              autoComplete="off"
              spellCheck={false}
            />
            <kbd>↑↓</kbd>
            <kbd>Tab</kbd>
            <button
              onClick={() => submitCommand()}
              disabled={!commandValue.trim() && activeSuggestion < 0}
              title={t("terminal.command.send")}
              aria-label={t("terminal.command.send")}
            >
              <SendHorizontal size={16} />
            </button>
            <button
              onClick={() => {
                setCommandOpen(false);
                terminalRef.current?.focus();
              }}
              title={t("terminal.command.close")}
              aria-label={t("terminal.command.close")}
            >
              <X size={15} />
            </button>
          </div>
          {commandSuggestions.length > 0 && (
            <div
              className="command-suggestions"
              role="listbox"
              aria-label={t("terminal.command.suggestions")}
            >
              {commandSuggestions.map((suggestion, index) => (
                <button
                  key={suggestion.id}
                  className={index === activeSuggestion ? "is-active" : ""}
                  role="option"
                  aria-selected={index === activeSuggestion}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setCommandValue(suggestion.command);
                    setActiveSuggestion(index);
                    commandInputRef.current?.focus();
                  }}
                  onDoubleClick={() => submitCommand(suggestion)}
                >
                  <span className="command-suggestion-icon">
                    {suggestion.source === "quick" ? (
                      <Zap size={14} />
                    ) : (
                      <Clock3 size={14} />
                    )}
                  </span>
                  <span className="command-suggestion-copy">
                    <strong>{suggestion.label}</strong>
                    {suggestion.label !== suggestion.command && (
                      <code>{suggestion.command}</code>
                    )}
                  </span>
                  <small>
                    {suggestion.source === "quick"
                      ? t("terminal.command.quick")
                      : t("terminal.command.history", {
                          count: suggestion.useCount,
                        })}
                  </small>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="terminal-context-menu"
          role="menu"
          aria-label={t("terminal.context.title")}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            role="menuitem"
            disabled={!contextMenu.hasSelection}
            onClick={() => runContextCommand("copy")}
          >
            <Copy size={14} />
            <span>{t("terminal.context.copy")}</span>
            <kbd>⌘C</kbd>
          </button>
          <button
            role="menuitem"
            disabled={session.state !== "connected" || session.transferActive}
            onClick={() => runContextCommand("paste")}
          >
            <ClipboardPaste size={14} />
            <span>{t("terminal.context.paste")}</span>
            <kbd>⌘V</kbd>
          </button>
          <button
            role="menuitem"
            onClick={() => runContextCommand("selectAll")}
          >
            <ScanText size={14} />
            <span>{t("terminal.context.selectAll")}</span>
            <kbd>⌘A</kbd>
          </button>
          <div className="terminal-context-separator" role="separator" />
          <button
            role="menuitem"
            disabled={receiveMode === "hex"}
            onClick={() => {
              setContextMenu(null);
              setSearchOpen(true);
              window.setTimeout(() => searchInputRef.current?.focus(), 0);
            }}
          >
            <Search size={14} />
            <span>{t("terminal.context.find")}</span>
            <kbd>⌘F</kbd>
          </button>
          <button
            role="menuitem"
            disabled={session.state !== "connected" || session.transferActive}
            onClick={() => {
              setContextMenu(null);
              openCommandComposer();
            }}
          >
            <CommandIcon size={14} />
            <span>{t("terminal.context.command")}</span>
            <kbd>⌘K</kbd>
          </button>
          <div className="terminal-context-separator" role="separator" />
          <button
            role="menuitem"
            onClick={() => {
              setContextMenu(null);
              clearTerminal();
            }}
          >
            <Trash2 size={14} />
            <span>{t("terminal.context.clear")}</span>
          </button>
        </div>
      )}
      {session.state === "opening" && (
        <div className="terminal-loading">
          <span className="spinner" />
          {t("terminal.opening", {
            target: sessionTargetLabel(profile, {
              sshUnset: t("profile.target.sshUnset"),
              adbUnset: t("profile.target.adbUnset"),
              serialUnset: t("profile.target.serialUnset"),
            }),
          })}
        </div>
      )}
    </section>
  );
}
