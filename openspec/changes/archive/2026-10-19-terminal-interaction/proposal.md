# Proposal

## Why

终端内联联想弹窗固定在面板底部（`bottom: 7px`），而 xterm 的光标行永远在视口最后一行，所以只要用户开始输入，最多 7 项、约 210px 高的浮层就会盖住正在输入的那一行，用户看不到自己敲进去的字符。

同时，右键行为只有"弹出菜单"一种：用户想复用一段输出必须走菜单里的"复制"，想粘贴也要走菜单（或用快捷键）。Windows 控制台用户习惯的"有选中就复制、没选中就粘贴"在本应用里没有，需要一个可选开关。

## What Changes

- **内联联想浮层改为跟随光标行**：浮层锚定在光标行的上一行，输入行始终可见；上方空间不足时翻转到光标行下方；限制最大高度并在内部滚动。
- **新增应用设置 `rightClickCopyPaste`**（默认关闭）：开启后终端内右键有选区则复制并清除选区，无选区则粘贴；`Shift+右键` 始终打开原有上下文菜单。
- 右键粘贴走与菜单粘贴相同的输入通道，因此会进入命令历史与内联联想；会话未连接或正在传输文件时，右键回退为打开上下文菜单。
- 右键快捷行为只作用于普通终端窗格，tmux control mode 分屏不在本次范围内。

## Capabilities

### New Capabilities

- `terminal-interaction`: 终端输入区与用户的直接交互约定，包括内联联想浮层的定位与尺寸约束、右键的复制/粘贴快捷动作及其设置项和菜单逃逸方式。

### Modified Capabilities

（无：`quick-commands` 只约束联想的数据来源，本次不改变其需求。）

## Impact

- `src/components/TerminalPane.tsx`：浮层定位计算、`onContextMenu` 分流。
- `src/styles.css`：`.terminal-inline-completion` 的锚定方式与尺寸上限。
- `src/lib/preferences.ts`、`src/lib/preferences.test.ts`：`AppPreferences` 新增布尔项及旧数据回退。
- `src/components/AppSettingsDialog.tsx`、`src/lib/i18n.tsx`：外观与行为分组新增开关与中英文案。
- `src/App.tsx` → `src/components/SessionTerminal.tsx` → `TerminalPane`：偏好透传。
- 新增 `src/lib/completionPlacement.ts`、`src/lib/terminalInteraction.ts` 及其单测。
- 不使用终端让位/重排方案，避免按键触发 xterm 重排与远端 PTY 尺寸变化。
