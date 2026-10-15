# Proposal

## Why

项目里的"快捷命令"不是一个独立概念：它直接复用发送预设（`SenderPreset`，存储于 `iterm.senders.v1`，按 profile 隔离），由每个终端窗格内的 `.terminal-quickbar` 渲染。这条栏有三处硬伤：分屏时被 CSS 整条隐藏；tmux control mode 下根本不渲染（`SessionTerminal` 走 `TmuxWorkspace`，不经过 `TerminalPane`）；作为覆盖层叠在终端之上，必须靠把终端顶上去 32px 才不遮挡输出。

用户需要的是：一份跨会话共享的"常用命令"，一条常驻在终端下方的命令栏，能右键编辑、点击直接发到当前 shell——而不是继续把发送预设当快捷命令用。

## What Changes

- 新增独立的"常用命令"数据模型与全局存储（跨会话共享，不按 profile 分隔），与发送预设彻底解耦。
- 新增全局命令栏：位于终端区下方、发送窗格之上的单条横栏，分屏与 tmux 会话下同样存在。
- 命令栏交互：点击命令直接发送到当前激活会话；栏内命令支持右键菜单（发送 / 编辑 / 复制一份 / 左移 / 右移 / 删除）；栏尾 `+` 新增；编辑使用栏内浮层（名称 / 内容 / 行尾）。
- 状态栏右下角新增独立的收起/展开开关（与"发送"开关互不影响），可见性持久化。
- 命令历史面板新增"收藏为常用命令"，作为"保存常用命令"的入口。
- 终端行内联想的 quick 来源由发送预设切换为常用命令库。
- **BREAKING（UI 移除）**：删除每个窗格内的 `.terminal-quickbar`，包括 `has-quickbar` 的终端偏移样式、`terminal.quickbar.*` 中英文案、以及 `TerminalPane` 的 `onOpenSender` 属性。发送预设本身保留，改为只服务发送窗格（hex / 循环 / 间隔 / 文件传输）。
- 行为变化：从命令栏发送不再写入命令历史（旧的窗格内快捷栏会写入）。

## Capabilities

### New Capabilities

- `quick-commands`: 常用命令库与全局命令栏——命令的持久化与编辑、栏的显示与收起、点击发送到当前会话，以及与命令历史和行内联想的联动。

### Modified Capabilities

- 无。项目当前尚无既有能力规格（`openspec/specs/` 为空），本次不修改任何既有规格。

## Impact

- 新增：`src/lib/quickCommands.ts`、`src/components/QuickCommandBar.tsx`。
- 修改：`src/App.tsx`（挂载命令栏、可见性状态、发送路由）、`src/components/TerminalPane.tsx`（移除旧栏与 `onOpenSender`）、`src/lib/workspace.ts`（新增 `quickBarOpen`）、`src/lib/commandHistory.ts`（联想 quick 源改为常用命令）、`src/lib/i18n.tsx`（新增常用命令文案、删除 `terminal.quickbar.*`）、`src/styles.css`（删除旧栏样式与偏移规则、新增命令栏样式）。
- 存储：新增 `iterm.quick-commands.v1`（沿用 `src/lib/persistence.ts` 的 `setPersistentItem`）；扩展 `iterm.workspace.v1`。
- 测试：新增 `src/lib/quickCommands.test.ts`；更新 `src/lib/commandHistory.test.ts`、`src/lib/workspace.test.ts`；e2e `e2e/workspace.spec.ts` 增加命令栏用例。
- 依赖与后端：无新增依赖；Rust 侧 `src-tauri/src/storage.rs` 的 `ALLOWED_STORAGE_KEYS` 必须加入新存储键，否则 SQLite 持久化会以“不允许持久化配置项”拒绝该键（发送到 tmux 活动窗格的能力已由现有 `paneTarget` 兜底）。
