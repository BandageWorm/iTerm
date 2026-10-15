import { Plus, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import {
  addQuickCommand,
  canAddQuickCommand,
  createQuickCommand,
  duplicateQuickCommand,
  moveQuickCommand,
  quickCommandLabel,
  removeQuickCommand,
  updateQuickCommand,
  type QuickCommand,
  type QuickCommandLineEnding,
} from "../lib/quickCommands";

interface QuickCommandBarProps {
  commands: QuickCommand[];
  connected: boolean;
  onCommandsChange: (commands: QuickCommand[]) => void;
  onSend: (command: QuickCommand) => void;
}

const LINE_ENDINGS: readonly QuickCommandLineEnding[] = [
  "terminal",
  "none",
  "lf",
  "cr",
  "crlf",
];

const MENU_WIDTH = 208;
const EDITOR_WIDTH = 328;

interface MenuState {
  id: string;
  left: number;
}

interface EditorState {
  mode: "create" | "edit";
  id: string;
  left: number;
  name: string;
  payload: string;
  lineEnding: QuickCommandLineEnding;
}

export function QuickCommandBar({
  commands,
  connected,
  onCommandsChange,
  onSend,
}: QuickCommandBarProps) {
  const { t } = useI18n();
  const barRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [notice, setNotice] = useState("");

  const lineEndingLabel = (value: QuickCommandLineEnding) => {
    if (value === "terminal") return t("quick.commands.lineEnding.terminal");
    if (value === "none") return t("quick.commands.lineEnding.none");
    return value.toUpperCase();
  };

  const clampLeft = (left: number, width: number) => {
    const bar = barRef.current?.getBoundingClientRect();
    const maxLeft = bar ? Math.max(8, bar.width - width) : left;
    return Math.max(8, Math.min(left, maxLeft));
  };

  const anchorLeft = (element: HTMLElement | null, width: number) => {
    const bar = barRef.current?.getBoundingClientRect();
    if (!bar || !element) return 8;
    return clampLeft(element.getBoundingClientRect().left - bar.left, width);
  };

  const menuCommand = menu
    ? commands.find((command) => command.id === menu.id) ?? null
    : null;

  useEffect(() => {
    if (!menu && !editor) return;
    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (editorRef.current?.contains(target)) return;
      setMenu(null);
      setEditor(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenu(null);
      setEditor(null);
    };
    window.addEventListener("mousedown", outside);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", escape);
    };
  }, [menu, editor]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2_400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const openMenu = (command: QuickCommand, element: HTMLElement) => {
    setEditor(null);
    setMenu({ id: command.id, left: anchorLeft(element, MENU_WIDTH) });
  };

  const openCreateEditor = (element: HTMLElement | null) => {
    if (!canAddQuickCommand(commands)) {
      setNotice(t("quick.commands.limit"));
      return;
    }
    setMenu(null);
    setEditor({
      mode: "create",
      id: "",
      left: anchorLeft(element, EDITOR_WIDTH),
      name: "",
      payload: "",
      lineEnding: "terminal",
    });
    window.setTimeout(() => nameInputRef.current?.focus(), 0);
  };

  const openEditEditor = (command: QuickCommand, left: number) => {
    setMenu(null);
    setEditor({
      mode: "edit",
      id: command.id,
      left: clampLeft(left, EDITOR_WIDTH),
      name: command.name,
      payload: command.payload,
      lineEnding: command.lineEnding,
    });
    window.setTimeout(() => nameInputRef.current?.focus(), 0);
  };

  const duplicate = (id: string) => {
    const next = duplicateQuickCommand(commands, id);
    if (next === commands) {
      setNotice(t("quick.commands.limit"));
      return;
    }
    onCommandsChange(next);
  };

  const saveEditor = () => {
    if (!editor) return;
    const payload = editor.payload.trim();
    if (!payload) return;
    if (editor.mode === "create") {
      const created = createQuickCommand(
        payload,
        editor.name.trim(),
        editor.lineEnding,
      );
      const next = addQuickCommand(commands, created);
      if (next === commands) {
        setNotice(t("quick.commands.limit"));
        return;
      }
      onCommandsChange(next);
    } else {
      onCommandsChange(
        updateQuickCommand(commands, editor.id, {
          name: editor.name.trim(),
          payload,
          lineEnding: editor.lineEnding,
        }),
      );
    }
    setEditor(null);
  };

  const remove = (id: string) => {
    onCommandsChange(removeQuickCommand(commands, id));
    setMenu(null);
    setEditor(null);
  };

  return (
    <div
      ref={barRef}
      className="quick-command-bar"
      role="toolbar"
      aria-label={t("quick.commands.bar")}
    >
      <span className="quick-command-bar-title">
        <Zap size={13} />
        {t("quick.commands.title")}
      </span>
      <div className="quick-command-bar-commands">
        {commands.length === 0 ? (
          <span className="quick-command-bar-empty">
            {t("quick.commands.empty")}
          </span>
        ) : (
          commands.map((command) => (
            <button
              key={command.id}
              type="button"
              aria-disabled={connected ? undefined : true}
              title={`${quickCommandLabel(command)} · ${command.payload}`}
              onClick={() => {
                if (connected) onSend(command);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                openMenu(command, event.currentTarget);
              }}
            >
              {quickCommandLabel(command)}
            </button>
          ))
        )}
      </div>
      {notice && (
        <span className="quick-command-bar-notice" role="status">
          {notice}
        </span>
      )}
      <button
        type="button"
        className="quick-command-bar-add"
        title={t("quick.commands.add")}
        aria-label={t("quick.commands.add")}
        onClick={(event) => openCreateEditor(event.currentTarget)}
      >
        <Plus size={14} />
      </button>

      {menu && menuCommand && (
        <div
          ref={menuRef}
          className="quick-command-menu"
          role="menu"
          aria-label={t("quick.commands.menu")}
          style={{ left: menu.left }}
        >
          <button
            type="button"
            role="menuitem"
            disabled={!connected}
            onClick={() => {
              onSend(menuCommand);
              setMenu(null);
            }}
          >
            {t("quick.commands.send")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => openEditEditor(menuCommand, menu.left)}
          >
            {t("quick.commands.edit")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              duplicate(menuCommand.id);
              setMenu(null);
            }}
          >
            {t("quick.commands.duplicate")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onCommandsChange(moveQuickCommand(commands, menuCommand.id, -1));
              setMenu(null);
            }}
          >
            {t("quick.commands.moveLeft")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onCommandsChange(moveQuickCommand(commands, menuCommand.id, 1));
              setMenu(null);
            }}
          >
            {t("quick.commands.moveRight")}
          </button>
          <span className="quick-command-menu-separator" />
          <button
            type="button"
            role="menuitem"
            onClick={() => remove(menuCommand.id)}
          >
            {t("quick.commands.delete")}
          </button>
        </div>
      )}

      {editor && (
        <div
          ref={editorRef}
          className="quick-command-editor"
          role="dialog"
          aria-label={
            editor.mode === "create"
              ? t("quick.commands.editor.create")
              : t("quick.commands.editor.edit")
          }
          style={{ left: editor.left }}
        >
          <label>
            <span>{t("quick.commands.editor.name")}</span>
            <input
              ref={nameInputRef}
              value={editor.name}
              onChange={(event) =>
                setEditor({ ...editor, name: event.target.value })
              }
            />
          </label>
          <label>
            <span>{t("quick.commands.editor.payload")}</span>
            <textarea
              rows={2}
              value={editor.payload}
              onChange={(event) =>
                setEditor({ ...editor, payload: event.target.value })
              }
            />
          </label>
          <label>
            <span>{t("quick.commands.editor.lineEnding")}</span>
            <select
              value={editor.lineEnding}
              onChange={(event) =>
                setEditor({
                  ...editor,
                  lineEnding: event.target.value as QuickCommandLineEnding,
                })
              }
            >
              {LINE_ENDINGS.map((value) => (
                <option key={value} value={value}>
                  {lineEndingLabel(value)}
                </option>
              ))}
            </select>
          </label>
          <div className="quick-command-editor-actions">
            {editor.mode === "edit" && (
              <button type="button" onClick={() => remove(editor.id)}>
                {t("quick.commands.delete")}
              </button>
            )}
            <button type="button" onClick={() => setEditor(null)}>
              {t("quick.commands.editor.cancel")}
            </button>
            <button
              type="button"
              className="is-primary"
              disabled={!editor.payload.trim()}
              onClick={saveEditor}
            >
              {t("quick.commands.editor.save")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
