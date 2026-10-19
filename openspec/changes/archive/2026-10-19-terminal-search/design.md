# Design

## Context

见 `proposal.md - Why`。与实现直接相关的现状：

- 查找通过窗口事件 `TERMINAL_SEARCH_EVENT` 广播（`src/lib/uiCommands.ts:1`、`requestTerminalSearch` 在 `:36`），`TerminalPane`（`src/components/TerminalPane.tsx:541`）与 tmux 的每个 `TmuxTerminal`（`src/components/SessionTerminal.tsx:220`）各自监听，各自持有自己的 `searchOpen` / `query` 状态。
- `TerminalPane` 的 Ctrl+F 分支只 `return false`（`TerminalPane.tsx:345`），tmux 分支有 `event.preventDefault()`（`SessionTerminal.tsx:161`）。
- xterm 的 keydown 监听丢弃自定义处理器的返回值，不会代为 `preventDefault`（`@xterm/xterm` 的 `_bindKeys`）。
- `.tmux-search` 仅有 `position: absolute; top: 4px; right: 22px; z-index: 1`（`src/styles.css:4537`），无任何外观。
- 查看菜单项在 `App.tsx` 的 `view` 组内构造（`App.tsx:2498`），命令栏可见性状态为 `quickBarOpen`（`App.tsx:364`），状态栏按钮已绑定同一状态（`App.tsx:3540`）。

## Goals / Non-Goals

**Goals:**

- 查找栏唯一性由机制保证，而不是靠各组件自觉关闭。
- 快捷键拦截是"事件默认行为"层面的，不依赖样式修补。
- tmux 与普通会话的查找入口共用外观与键盘语义。

**Non-Goals:**

- 不重写查找匹配逻辑，不引入跨会话全局搜索。
- 不改终端主题变量与调色板解析。
- 不为 tmux 分屏增加新的按钮或工具栏。

## Decisions

### 1. 唯一性：把查找请求变成带序号的全局请求

`TERMINAL_SEARCH_EVENT` 由普通 `Event` 升级为 `CustomEvent<{ requestId: number }>`；`requestTerminalSearch()` 内部维护递增计数，每次触发分配新 `requestId` 并广播。每个持有查找状态的组件记录"我接受过的 requestId"，收到更新的 id 时立即关闭自己的查找栏，只让最新请求生效。

终端内的 Ctrl+F 不再直接 `setSearchOpen(true)`，改为调用 `requestTerminalSearch()`，使键盘与工具栏按钮走同一条路径；否则键盘入口会绕过唯一性约束。

备选方案：用 React context 存放单一"当前查找归属"，组件向 context 注册自己。否决原因：tmux 分屏与普通窗格分属不同组件树层级，引入 context 会牵动 `App` → `SessionTerminal` → `TmuxWorkspace` 的 props 传递，改动面大于收益。

实现补记：只用 `requestId` + `active` 判定存在竞态——点击窗格到 React 提交 `active` 之间若已按下 Ctrl+F，监听器闭包里的 `active` 还是旧值，可能一条都不开。因此键盘触发的请求额外携带请求方标识（`source`，每个窗格一个稳定对象），监听器优先按标识匹配，只有来自工具栏等全局入口（无标识）时才回退到 `active` 判定。`requestId` 仍然保留，用于抑制乱序的旧请求。

### 2. 快捷键拦截：统一 `preventDefault`

`TerminalPane` 的 Ctrl+F、Ctrl+Shift+C/V、Ctrl+Shift+K 分支在 `return false` 前补 `event.preventDefault()`；`return false` 只表示"xterm 不要再处理"，拦截宿主默认行为必须显式做。tmux 分支已具备该行为，保持不动。

### 3. tmux 查找输入复用主查找栏的 token

给 `.tmux-search` 应用与 `.terminal-search` 相同的一组变量（`--terminal-control` / `--terminal-border` / `--terminal-label`、高度、圆角、内边距、字号），并与 `.terminal-search input` 一样使用 `--content-background` 作为输入底色。不把它包进完整容器，是因为 tmux 分屏空间小，单个输入框已足够，且避免引入图标与计数等在本场景无意义的元素。

键盘语义对齐：Esc 关闭（现有）、Enter 下一个（现有）、Shift+Enter 上一个（现有），额外要求 Esc 后 `terminalRef.current?.focus()` 回焦；与主查找栏的 Esc 行为保持一致。

### 4. 查找栏自己持有键盘焦点

查找栏打开后必须由输入框持有焦点。原实现用 `setTimeout(..., 0)` 聚焦，但同一帧内激活窗格的 `requestAnimationFrame` 会把焦点抢回终端，且停留在终端时按键会写进会话。改为：`searchOpen` 变为真时由 effect 聚焦（此时输入框已提交到 DOM）；激活窗格的聚焦 rAF 在 `searchOpen` 为真时跳过，并在清理时取消尚未执行的帧，避免陈旧闭包抢焦点；快捷键的 keyup 也返回 `false`，阻止 xterm 在 `_keyUp` 中把焦点交还终端。

### 5. 查看菜单项与状态栏共用状态

在 `view` 组的"发送窗格"之后插入菜单项，`checked: quickBarOpen`，`onSelect` 复用 `setQuickBarOpen`。两者读写同一个 `quickBarOpen`，天然同步，无需额外事件。专注模式下命令栏由既有规则隐藏，菜单项保持可点击，勾选状态仍反映用户的显式选择（与状态栏按钮一致）。

## Risks / Trade-offs

- **唯一性引入"关闭他人"的副作用** → 只有当用户主动触发新的查找时才关闭旧的，不会在切换会话时被动关闭；关闭动作不改变终端的选区与滚动位置。
- **Ctrl+Shift+C/V 拦截后，某些输入法/宿主组合键可能行为变化** → 该组合键本来就被应用占用（复制/粘贴），拦截只去掉叠加的原生动作，符合用户预期。
- **tmux 查找框尺寸变化影响 pane 标签位置** → `.tmux-pane-label` 在右上角，输入框定位在 `right: 22px`，高度变化时需复核不遮挡标签。
- **菜单项增加后与状态栏按钮重复** → 两份入口是需求明确要求；通过共享状态避免不一致。
