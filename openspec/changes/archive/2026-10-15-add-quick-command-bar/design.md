# Design

## Context

动机见 `proposal.md - Why`，行为契约见 `specs/quick-commands/spec.md`。这里只记录影响做法的现状约束：

- "快捷命令"目前没有自己的数据模型：`buildCommandSuggestions`（`src/lib/commandHistory.ts`）把 text 模式的 `SenderPreset` 当作 quick 来源，`loadSenderPresets`（`src/lib/senders.ts`）按 `profileId` 分键存 `iterm.senders.v1`。
- 旧的 `.terminal-quickbar` 挂在 `TerminalPane` 内部，是 `position: absolute; bottom: 0` 的覆盖层，因此 `src/styles.css` 里存在 `has-quickbar` 与 `has-command-composer` / `has-command-suggestions` 组合出的 6 条偏移规则，把终端向上顶 32px 以避免遮挡。
- 终端尺寸自适应已经现成：`TerminalPane` 对宿主元素挂了 `ResizeObserver`，尺寸变化后 `fit.fit()` 并触发 `onResize`；tmux 工作区里有独立的测量终端做同样的事。
- `src/components/SessionTerminal.tsx` 在 tmux control mode 激活时渲染 `TmuxWorkspace` 而不是 `TerminalPane`，所以窗格内栏在 tmux 会话下根本不存在。
- 发送到 tmux 会话不需要新管道：`writeProcessBytes` 在不传 `paneId` 时由 `TmuxClient.paneTarget(undefined)` 解析为"活动窗口的活动 pane"，非 tmux 会话则走原始字节写入。
- `.main-area` 是 `display: flex; flex-direction: column`，其子节点依次是 tab-strip、terminal-stack、sender dock、statusbar；`.sender-pane` 是底部 dock（`border-top`、向上投影），不是侧边窗格。
- 应用状态持久化分散在 `src/lib/workspace.ts`（外壳快照）、`src/lib/senders.ts`、`src/lib/commandHistory.ts`，统一经 `src/lib/persistence.ts` 的 `setPersistentItem`。

## Goals / Non-Goals

**Goals:**

- 常用命令成为独立、全局、可持久化的数据模型，与发送预设解耦。
- 命令栏是 `.main-area` 里的正常布局行，不是覆盖层，因此不再需要任何"把终端顶上去"的偏移规则。
- 复用既有的会话写入口与终端自适应，不新增 IPC、不引入新依赖。

**Non-Goals:**

- 不改动发送窗格既有能力（hex 发送、循环发送、间隔、文件传输）。
- 不做拖拽排序、分组、图标、快捷键直达某一命令。
- 不做 `iterm.senders.v1` 到新命令库的自动迁移。
- 不做云同步或多窗口共享。

## Decisions

### 1. 常用命令使用独立数据模型与独立存储键

新增 `src/lib/quickCommands.ts`，导出 `QuickCommand { id, name, payload, lineEnding }`，其中 `lineEnding` 取值复用现有 `LineEnding | "terminal"`（`terminal` 表示跟随会话回车键）。存储键为 `iterm.quick-commands.v1`，是**单个数组**，不按 `profileId` 分键，读取时对未知字段做与 `commandHistory.ts` 一致的容错（丢弃无 `payload` 的条目、截断超长内容、限制条数）。该键必须同时登记到两处白名单：前端 `src/lib/persistence.ts` 的 `PERSISTENT_STORAGE_KEYS` 与 Rust `src-tauri/src/storage.rs` 的 `ALLOWED_STORAGE_KEYS`。只改前端会让 `save_persistent_items` 被 `validate_key` 拒绝，界面弹出“不允许持久化配置项”并回落为仅浏览器存储。

替代方案：沿用 `SenderPreset` 并在其上增加"是否显示在命令栏"标记。放弃原因是 `repeat` / `intervalMs` / `mode: "hex"` 对"常用命令"没有意义，且发送预设按 profile 隔离，而需求明确要求跨会话共享；强行复用会让一份列表承载两种语义。

### 2. 命令栏作为 `.main-area` 的 flex 行，插在 terminal-stack 与 sender dock 之间

`QuickCommandBar` 渲染为 `flex: 0 0 32px` 的 flex 子节点，DOM 顺序在 `terminal-stack` 之后、`sender-pane` 之前。终端因此被正常挤压，`ResizeObserver` 负责重排，无需新代码。

替代方案：把栏作为 `terminal-stack` 的绝对定位子节点、用 `.terminal-stack.has-quickbar .terminal-host { bottom: 32px }` 把终端顶上去——即旧的 `has-quickbar` 思路。放弃原因是它要求栏的可见性参与终端宿主的多组偏移选择（旧的 6 条规则就是这么来的），而且栏成为终端栈的子节点后会横跨分屏边界、需要额外处理窗格与栏的层叠关系。flex 行把这些全部消掉。

不放在 statusbar 之上（最底部）的原因：发送窗格一展开，栏就会被挤到发送窗格下方，与终端断开，失去"命令栏"的位置语义。

### 3. 发送目标复用现有会话写入口

栏点击调用 App 里现成的 `writeTerminalInput(activeSession, activeProfile, payload + ending)`，**不传 `paneId`**。行尾用 `commandLineEnding(lineEnding, activeProfile.terminal.enterKey)` 解析，与旧栏一致。tmux 会话自动落到活动窗口的活动 pane，串口/SSH 走原始写入。

替代方案：把 tmux 活动 pane id 从 `TmuxWorkspace` 提升到 App 再显式传入。放弃原因是活动 pane 由 tmux 服务端状态（`pane.active`）决定，前端提升一份副本只会产生第二真值源。

因为不经过 `TerminalPane` 的 `trackedInputRef` 链路，命令栏发送不会写入命令历史——这正是期望结果（旧栏会写入，属于行为变化，已在 proposal 中声明）。

### 4. 收起/展开开关放状态栏右下角

新增开关与现有"发送"按钮并列，位于 statusbar 的 `.status-items` 内，状态存在 `WorkspaceSnapshot` 的新字段 `quickBarOpen`（默认 `true`，读取时按布尔兜底，无需迁移）。

替代方案：把开关放在栏自身的右端。放弃原因是收起的一瞬间按钮随栏一起消失，用户失去展开入口；放在状态栏则两个方向都可达。

### 5. 编辑交互用就地浮层，不做独立管理对话框

右键命令弹出菜单（发送 / 编辑 / 复制一份 / 左移 / 右移 / 删除），编辑与新增共用同一个浮层（名称 / 内容 / 行尾 / 保存 / 取消 / 删除）。栏尾 `+` 打开空白浮层。

替代方案：单独做一个"管理常用命令"对话框做批量列表编辑。放弃原因是栏本身已经承载浏览与排序（左移/右移），一次只编辑一条时对话框是多余的一层，且与"右键编辑"的诉求不符。排序用左移/右移而不是拖拽，避免引入拖拽实现与可访问性处理。

栏在 pane 之外，右键不再与终端区域菜单（`TerminalPane` 的 `onContextMenu`）冲突，无需 `stopPropagation`。

### 6. 数据读取沿用"组件自行 load + 聚焦时 refresh"的既有模式

`QuickCommandBar` 由 `App` 持有可见性状态；`TerminalPane` 的内联联想继续自行 `loadQuickCommands()` 并在打开命令输入器时刷新，与当前对待 `loadSenderPresets` 的方式一致。理由：避免为联想新增跨层 prop，且编辑后刷新时机与现状相同。

`buildCommandSuggestions` 的第三参类型由 `SenderPreset[]` 改为 `QuickCommand[]`，`source: "quick"` 的 `lineEnding` 改为 `QuickCommand["lineEnding"]`。

### 7. 历史面板增加收藏入口

在 `.terminal-history-list` 的每个条目上增加收藏按钮，调用命令库的"按 payload 去重后追加"操作；已收藏的条目显示为已收藏状态。这是"保存常用命令"最自然的落点，无需额外入口。

### 8. 删除旧的窗格内快捷栏及其全部配套

删除 `TerminalPane` 的栏 JSX 与 `has-quickbar` class、`onOpenSender` 属性（`App.tsx` 传入处一并删除）、`styles.css` 中 5 组相关规则、i18n 中 `terminal.quickbar.title` / `terminal.quickbar.configure` 两个键（中英各一份）。新文案放 `quick.commands.*` 命名空间。

代价：终端内不再有打开发送窗格的按钮。发送窗格仍可经 `Ctrl/⌘+J`、View 菜单、状态栏"发送"按钮打开，功能未丢失。

### 9. 命令按钮用 `aria-disabled`，而不是原生 `disabled`

未连接会话时命令按钮必须呈现为不可发送，但 Chromium 对原生 `disabled` 的表单控件**不派发鼠标事件**，`contextmenu` 也就不会触发，右键菜单因此永远打不开——这会让"没连会话就无法编辑/删除已有命令"，与规格「每条命令 SHALL 支持右键打开操作菜单」冲突。因此改用 `aria-disabled="true"`（样式同步为 `[aria-disabled="true"]`），点击处理里提前返回以保证"点击不会发送任何数据"。注意 Playwright 也会把 `aria-disabled` 视为不可点击，e2e 里对这类元素需要 `force: true` 才能模拟真实右键。

### 10. 菜单与编辑浮层按各自宽度做边界夹取

两者都锚定在命令按钮上方，横向位置按"按钮左缘 − 栏左缘"计算并夹取到栏宽之内。菜单与浮层宽度不同（`border-box` 下分别为 208px 与 328px），必须各自夹取；共用菜单宽度会让 320px 的编辑浮层在窗口右缘被裁掉（`+` 按钮在最右侧时最容易触发）。

## Risks / Trade-offs

- [命令栏收起/展开导致终端尺寸变化，tmux 会话会触发 `refresh-client -C`] → 尺寸自适应已有 rAF 节流，沿用即可；若高频切换出现抖动，退化为在状态稳定后统一 resize，不改规格。
- [删除窗格内栏会移除终端内打开发送窗格的唯一按钮] → 保留三个既有入口（快捷键、菜单、状态栏），并在 CHANGELOG 中说明。
- [旧 `iterm.senders.v1` 里的文本预设不会出现在新命令栏，用户可能觉得"命令丢了"] → 不自动迁移是刻意的（发送预设按 profile、语义不同）；在 CHANGELOG 中说明差异，并把"一次性导入"留作后续可选的独立变更。
- [窄窗口下命令较多时栏需要横向滚动] → 沿用旧栏的 `overflow-x: auto` + 隐藏滚动条；`@media (max-width: 980px)` 只隐藏历史面板，不影响命令栏。
- [e2e 依赖可访问名定位（项目不使用 testid）] → 命令栏、右键菜单、编辑浮层都要提供明确的 `role` 与 `aria-label`，且中英文案同步补齐，否则现有 e2e 约定无法覆盖新 UI。

## Migration Plan

1. 新增 `iterm.quick-commands.v1`（前端与 Rust 两处白名单同改，见 Decision 1）；不读写、不修改 `iterm.senders.v1`。
2. `WorkspaceSnapshot` 新增 `quickBarOpen: boolean`，读取时缺字段默认 `true`，因此旧快照无需迁移。
3. 常规发布顺序即可：先落数据层与组件，再删除旧的窗格内栏（删除与新增同一次发布，避免两个"快捷命令"入口并存）。
4. 回滚：恢复被删除的栏 JSX 与样式即可；新存储键不被旧代码读取，不会污染旧数据。
