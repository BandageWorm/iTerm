import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ComponentProps } from "react";
import { LogOut, Plus, Columns2, Rows2 } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { TerminalPane } from "./TerminalPane";
import { getProcessTmuxClient, subscribeProcessTmuxClients } from "../lib/remote";
import { useI18n } from "../lib/i18n";
import { installUnicode11, mapTerminalSpecialKey, clampTerminalFontSize, DEFAULT_TERMINAL_FONT_SIZE } from "../lib/terminal";
import { resolveTerminalTheme } from "../lib/terminalTheme";
import { executeTerminalCommand, requestTerminalSearch, TERMINAL_COMMAND_EVENT, TERMINAL_SEARCH_EVENT, type TerminalUiCommand } from "../lib/uiCommands";
import { EMPTY_TMUX_SNAPSHOT, type TmuxClient, type TmuxPane } from "../lib/tmux";

type Props = ComponentProps<typeof TerminalPane> & {
  onTmuxInput: (paneId: string, bytes: Uint8Array) => void;
};

const subscribeInactive = () => () => undefined;
const getInactiveSnapshot = () => EMPTY_TMUX_SNAPSHOT;

export function SessionTerminal(props: Props) {
  const getClient = useCallback(() => getProcessTmuxClient(props.session.id), [props.session.id]);
  const client = useSyncExternalStore(subscribeProcessTmuxClients, getClient);
  const snapshot = useSyncExternalStore(client?.subscribe ?? subscribeInactive, client?.getSnapshot ?? getInactiveSnapshot);
  return client && snapshot.active
    ? <TmuxWorkspace {...props} client={client} />
    : <TerminalPane {...props} />;
}

function TmuxWorkspace(props: Props & { client: TmuxClient }) {
  const { client, profile, active, visible, onActivate, theme } = props;
  const { t } = useI18n();
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [error, setError] = useState("");
  const sizingHost = useRef<HTMLDivElement>(null);
  const resize = useRef(props.onResize);
  resize.current = props.onResize;
  const currentWindow = snapshot.windows.find((window) => window.id === snapshot.activeWindowId)
    ?? snapshot.windows.find((window) => window.active) ?? snapshot.windows[0];
  const run = (operation: Promise<void>) => {
    setError("");
    void operation.catch((reason: unknown) => setError(String(reason)));
  };

  // Fit a full-window terminal to measure actual font cells without guessing
  // glyph dimensions. Each visible pane keeps the dimensions assigned by tmux.
  useEffect(() => {
    if (!sizingHost.current || !visible) return;
    const terminal = new Terminal({
      fontFamily: profile.terminal.fontFamily,
      fontSize: profile.terminal.fontSize,
      lineHeight: profile.terminal.lineHeight,
      scrollback: 0,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(sizingHost.current);
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const size = fit.proposeDimensions();
        if (size && size.cols >= 2 && size.rows >= 1) {
          resize.current(size.cols, size.rows);
        }
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(sizingHost.current);
    update();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); terminal.dispose(); };
  }, [client, visible, profile.terminal.fontFamily, profile.terminal.fontSize, profile.terminal.lineHeight]);

  return (
    <section className={`terminal-pane tmux-workspace ${visible ? "is-visible" : ""} ${active ? "is-active" : ""}`}
      aria-label={t("tmux.workspace")} onMouseDown={onActivate}>
      <div className="tmux-toolbar">
        <span className="tmux-session">tmux · {snapshot.sessionName}</span>
        <div className="tmux-tabs" role="tablist" aria-label={t("tmux.windows")}>
          {snapshot.windows.map((window) => (
            <button key={window.id} role="tab" aria-selected={window.id === currentWindow?.id}
              onClick={() => run(client.selectWindow(window.id))}>
              {window.index}: {window.name}
            </button>
          ))}
        </div>
        <button className="icon-button" title={t("tmux.newWindow")} aria-label={t("tmux.newWindow")}
          onClick={() => run(client.newWindow())}><Plus size={16} /></button>
        <button className="icon-button" title={t("tmux.splitHorizontal")} aria-label={t("tmux.splitHorizontal")}
          disabled={!currentWindow} onClick={() => run(client.splitWindow("horizontal"))}><Columns2 size={16} /></button>
        <button className="icon-button" title={t("tmux.splitVertical")} aria-label={t("tmux.splitVertical")}
          disabled={!currentWindow} onClick={() => run(client.splitWindow("vertical"))}><Rows2 size={16} /></button>
        <button className="icon-button" title={t("tmux.detach")} aria-label={t("tmux.detach")}
          onClick={() => run(client.detach())}><LogOut size={16} /></button>
      </div>
      {(error || snapshot.error) && <div className="tmux-error" role="alert">{error || snapshot.error}</div>}
      <div className="tmux-canvas">
        <div ref={sizingHost} className="tmux-sizing" aria-hidden="true" inert />
        {!currentWindow && <div className="tmux-waiting">{t("tmux.loading")}</div>}
        {snapshot.panes.map((pane) => {
          const window = snapshot.windows.find((item) => item.id === pane.windowId);
          if (!window) return null;
          return <TmuxTerminal key={pane.id} pane={pane} client={client} profile={profile} theme={theme}
            active={active && pane.active && window.id === currentWindow?.id}
            visible={visible && window.id === currentWindow?.id}
            width={window.width} height={window.height}
            onError={setError} onActivate={onActivate} onFontSizeChange={props.onFontSizeChange} onInput={(bytes) => props.onTmuxInput(pane.id, bytes)} />;
        })}
      </div>
    </section>
  );
}

function TmuxTerminal({ pane, client, profile, theme, active, visible, width, height, onError, onActivate, onInput, onFontSizeChange }: {
  pane: TmuxPane; client: TmuxClient; profile: Props["profile"]; theme: Props["theme"];
  active: boolean; visible: boolean; width: number; height: number;
  onFontSizeChange: (size: number) => void;
  onError: (message: string) => void; onActivate: () => void; onInput: (bytes: Uint8Array) => void;
}) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const outputRevision = useRef(-1);
  const searchRequestRef = useRef(0);
  const searchSourceRef = useRef<object>({});
  const [query, setQuery] = useState<string | null>(null);
  const latest = useRef({ pane, onError, onInput, profile, onFontSizeChange });
  latest.current = { pane, onError, onInput, profile, onFontSizeChange };
  const send = (value: string) => {
    latest.current.onInput(new TextEncoder().encode(value));
  };

  useEffect(() => {
    if (!host.current) return;
    const terminal = new Terminal({
      cols: latest.current.pane.width, rows: latest.current.pane.height,
      fontFamily: profile.terminal.fontFamily, fontSize: profile.terminal.fontSize,
      lineHeight: profile.terminal.lineHeight, cursorStyle: profile.terminal.cursorStyle,
      scrollback: profile.terminal.scrollback, convertEol: false,
      theme: resolveTerminalTheme(theme, profile.terminal.paletteMode, profile.terminal.customPalette), allowProposedApi: true,
    });
    installUnicode11(terminal);
    const search = new SearchAddon();
    terminal.loadAddon(search);
    terminal.open(host.current);
    terminalRef.current = terminal;
    searchRef.current = search;
    outputRevision.current = -1;
    const data = terminal.onData(send);
    const binary = terminal.onBinary((value) => {
      latest.current.onInput(Uint8Array.from(value, (character) => character.charCodeAt(0)));
    });
    terminal.attachCustomKeyEventHandler((event) => {
      const key = event.key.toLowerCase();
      if (event.type === "keydown" && (event.ctrlKey || event.metaKey) && ["+", "=", "-", "_", "0"].includes(key)) {
        event.preventDefault();
        event.stopPropagation();
        latest.current.onFontSizeChange(key === "0" ? DEFAULT_TERMINAL_FONT_SIZE
          : clampTerminalFontSize(latest.current.profile.terminal.fontSize + (["+", "="].includes(key) ? 1 : -1)));
        return false;
      }
      if (event.type === "keydown" && (event.ctrlKey || event.metaKey) && key === "f") {
        event.preventDefault();
        requestTerminalSearch({ source: searchSourceRef.current });
        return false;
      }
      const copy = (event.metaKey && key === "c" && terminal.hasSelection()) || (event.ctrlKey && event.shiftKey && key === "c");
      const paste = (event.metaKey && key === "v") || (event.ctrlKey && event.shiftKey && key === "v");
      if (event.type === "keydown" && (copy || paste)) {
        event.preventDefault();
        void executeTerminalCommand(copy ? "copy" : "paste", terminal, send)
          .catch((reason: unknown) => latest.current.onError(String(reason)));
        return false;
      }
      const mapped = mapTerminalSpecialKey(event, latest.current.profile.terminal);
      if (mapped !== null) { send(mapped); return false; }
      return true;
    });
    const write = (bytes: Uint8Array, revision: number) => {
      if (outputRevision.current !== revision) {
        // Queue RIS with the capture so older pending writes cannot land after
        // a synchronous reset and contaminate the restored screen.
        terminal.write("\x1bc");
        outputRevision.current = revision;
      }
      terminal.write(bytes);
    };
    const current = client.getSnapshot().panes.find((entry) => entry.id === pane.id);
    if (current) {
      for (const chunk of current.receiveChunks) write(new Uint8Array(chunk.bytes), current.outputRevision);
    }
    const output = client.subscribeOutput((paneId, bytes, revision) => {
      if (paneId === pane.id) write(bytes, revision);
    });
    return () => { output(); data.dispose(); binary.dispose(); terminal.dispose(); terminalRef.current = null; };
    // Keep the terminal and its full screen/scrollback alive across appearance changes.
  }, [client, pane.id]);

  useEffect(() => {
    if (!terminalRef.current) return;
    terminalRef.current.options = {
      fontFamily: profile.terminal.fontFamily, fontSize: profile.terminal.fontSize,
      lineHeight: profile.terminal.lineHeight, cursorStyle: profile.terminal.cursorStyle,
      scrollback: profile.terminal.scrollback,
      theme: resolveTerminalTheme(theme, profile.terminal.paletteMode, profile.terminal.customPalette),
    };
  }, [profile.terminal, theme]);

  useEffect(() => {
    terminalRef.current?.resize(pane.width, pane.height);
  }, [pane.width, pane.height]);

  useEffect(() => {
    if (!visible) return;
    if (active) terminalRef.current?.focus();
    const command = (event: Event) => {
      if (!terminalRef.current) return;
      void executeTerminalCommand((event as CustomEvent<TerminalUiCommand>).detail, terminalRef.current, send)
        .catch((reason: unknown) => onError(String(reason)));
    };
    const search = (event: Event) => {
      const detail = (event as CustomEvent<{ requestId?: number; source?: unknown }>).detail;
      if (typeof detail?.requestId === "number") {
        if (detail.requestId <= searchRequestRef.current) return;
        searchRequestRef.current = detail.requestId;
      }
      const shouldOpen =
        detail?.source === undefined ? active : detail.source === searchSourceRef.current;
      setQuery(shouldOpen ? "" : null);
    };
    if (active) {
      window.addEventListener(TERMINAL_COMMAND_EVENT, command);
    }
    window.addEventListener(TERMINAL_SEARCH_EVENT, search);
    return () => {
      window.removeEventListener(TERMINAL_COMMAND_EVENT, command);
      window.removeEventListener(TERMINAL_SEARCH_EVENT, search);
    };
  }, [client, pane.id, active, visible]);

  return <div className={`tmux-pane ${pane.active ? "is-active" : ""}`}
    style={{ display: visible ? "block" : "none", left: `${pane.left / width * 100}%`, top: `${pane.top / height * 100}%`,
      width: `${pane.width / width * 100}%`, height: `${pane.height / height * 100}%` }}
    aria-label={t("tmux.pane", { id: pane.id })}
    onWheel={(event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      onFontSizeChange(clampTerminalFontSize(profile.terminal.fontSize + (event.deltaY < 0 ? 1 : -1)));
    }}
    onMouseDown={() => { onActivate(); if (!pane.active) void client.selectPane(pane.id).catch((reason: unknown) => onError(String(reason))); }}>
    <div ref={host} className="tmux-terminal" style={{ background: resolveTerminalTheme(theme, profile.terminal.paletteMode, profile.terminal.customPalette).background }} />
    <span className="tmux-pane-label">{pane.id}</span>
    {query !== null && <input className="tmux-search" autoFocus aria-label={t("terminal.search")}
      value={query} placeholder={t("terminal.search")}
      onChange={(event) => { setQuery(event.target.value); searchRef.current?.findNext(event.target.value); }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.shiftKey ? searchRef.current?.findPrevious(query) : searchRef.current?.findNext(query);
        if (event.key === "Escape") {
          setQuery(null);
          window.setTimeout(() => terminalRef.current?.focus(), 0);
        }
      }} />}
  </div>;
}
