# Design

## Context

见 `proposal.md - Why`。落地相关的现状约束：

- 浮层是 `.terminal-pane` 内的绝对定位元素，当前规则为 `left: 7px; right: 229px; bottom: 7px`（`src/styles.css:4376`），横向已为右侧历史停靠列（216px）留位。
- 终端宿主 `.terminal-host` 在需要让位时才改 `bottom`（命令输入面板 `53px` / 带联想 `250px`，`src/styles.css:3657`），行内联想没有参与布局。
- 浮层由 `TerminalPane` 直接渲染，最多 7 项 + footer（`src/components/TerminalPane.tsx:732`），当前无高度上限。
- 右键目前只有一条路径：`section` 的 `onContextMenu` 计算位置后打开菜单（`TerminalPane.tsx:637`）。
- xterm 6 已确认：其自身 `contextmenu` 处理不会 `preventDefault`，且 `rightClickSelectsWord` 未开启，因此右键不会破坏既有选区，`hasSelection()` 在 `onContextMenu` 中可信。
- 复制/粘贴已有唯一入口 `executeTerminalCommand`（`src/lib/uiCommands.ts:53`），菜单走 `runContextCommand`，其中粘贴通过 `trackedInputRef` 回灌，才能进入命令历史与联想。

## Goals / Non-Goals

**Goals:**

- 浮层位置由光标行决定，输入行在任何窗格高度、任何滚动位置下都可见。
- 位置计算可单测，重算不改动终端尺寸。
- 右键快捷动作与菜单动作共用同一份剪贴板/输入通道，行为差异只体现在触发方式。

**Non-Goals:**

- 不实现"终端让位"（改 `.terminal-host` bottom）来给浮层腾位置：每次按键都会触发 xterm 重排与 `onResize`，串口/SSH 会话不可接受。
- 不实现终端画布内的 ghost text 补全：串口回显与远端重绘会互相覆盖。
- 不为 tmux control mode 分屏新增右键菜单。

## Decisions

### 1. 锚点用光标行而不是面板底部

用 `terminal.buffer.active` 的 `cursorY - baseY` 得到光标在视口中的行号，行高由 `.xterm-screen` 高度除以 `terminal.rows` 得到（比用宿主高度更贴近渲染结果）。锚定规则：

```
光标行顶边(相对面板) = screenTop + cursorRow * rowHeight
上方空间 = 该值 - paneTop
若 上方空间 >= 浮层高度 + 间隙  -> 浮层底边贴 光标行顶边 - 间隙（above）
否则                              -> 浮层顶边贴 光标行底边 + 间隙（below）
```

位置通过面板级 CSS 变量（`--completion-offset` + `data-placement`）下发，`left` / `right` 规则保持不变，避免在 React 里拼内联样式串。

备选方案：把面板按浮层高度整体上移（当前命令输入面板的做法）。否决原因见 Non-Goals。备选：纯 CSS 改成"右下角小卡片"。否决原因：长命令仍会被压住，问题只被缓解。

### 2. 重算时机收敛到一个 rAF

监听 `onCursorMove`、`onResize`、`onScroll`、宿主的 `ResizeObserver`、字号变化与联想条数变化，全部合并到一次 `requestAnimationFrame` 后的测量 + 写入；浮层自身高度在 `useLayoutEffect` 里量，因为条数变化会改变高度，而高度决定 above/below 的选择。滚动回看历史时按当前视口行计算，浮层跟随视口而不是缓冲区。

### 3. 高度上限与滚动容器

浮层拆成"列表 + footer"两层：列表 `max-height: min(6 * 行高, 45%)` 且 `overflow: auto`，footer 固定不滚。这样位置计算只需考虑上限高度，且项数变化不会让浮层无限变高。

### 4. 右键动作抽成纯函数

`resolveRightClickAction({enabled, shiftKey, hasSelection, canPaste})` 返回 `copy | paste | menu`：

| enabled | shift | hasSelection | canPaste | 结果 |
|---|---|---|---|---|
| false | * | * | * | menu |
| true | true | * | * | menu |
| true | false | true | * | copy |
| true | false | false | true | paste |
| true | false | false | false | menu（回退，保证菜单可达） |

`canPaste = session.state === "connected" && !session.transferActive`，与菜单项禁用条件一致。

### 5. 复制后清除选区

`cmd` 的右键复制会清掉选区，这里保持一致：清除既是视觉反馈，也避免下一次右键重复复制同一段文本、永远轮不到粘贴。

### 6. 偏好项与透传

`AppPreferences` 增加 `rightClickCopyPaste: boolean`（默认 `false`），`loadAppPreferences` 按 `typeof === "boolean"` 校验后回退默认，与 `confirmActiveSessionClose` 同一写法。偏好经 `App` → `SessionTerminal` → `TerminalPane` 以 prop 透传；`TmuxTerminal` 不接收该 prop，tmux 分屏行为不变。

## Risks / Trade-offs

- **WebGL 渲染下行高取整误差** → 只做整数像素对齐，浮层与光标行之间留 4px 间隙吸收误差；测量在 `requestAnimationFrame` 之后进行。
- **光标行在顶部附近时翻转** → 翻转后浮层压在光标行下方历史输出上，这是可接受的代价；若上下都不够，优先 below 并裁剪到面板内。
- **滚动回看时浮层位置跳动** → 跟随视口行符合"浮层贴近当前输入"的语义；若用户回看历史，浮层停在其上方的光标行位置，不强制滚回底部。
- **清除选区是本改动引入的唯一破坏性行为** → 仅在开关开启且复制成功时清除；开关默认关闭。
- **剪贴板读取被拒绝或为空** → 不发送数据，回退为打开上下文菜单，避免"右键没反应"。
- **依赖 xterm 私有几何** → 只用公开的 `buffer.active` / `rows` / `.xterm-screen` 元素尺寸，不触碰 `_core`；升级 xterm 时只需复核行高计算。

## Migration Plan

无数据迁移：新偏好项缺省即 `false`，旧版本本地存储原样读取。回滚只需移除开关并使 `resolveRightClickAction` 恒返回 `menu`，浮层定位回退到 CSS 的 `bottom` 锚定。
