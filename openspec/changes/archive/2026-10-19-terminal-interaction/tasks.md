# Tasks

## 1. 浮层定位

- [x] 1.1 新增 `src/lib/completionPlacement.ts`，实现 `resolveCompletionPlacement({ rows, rowHeight, cursorRow, paneHeight, popupHeight, gap, margin })`，返回 `{ placement: "above" | "below", offset }`，并用 `src/lib/completionPlacement.test.ts` 覆盖末行上移、顶部翻转、上下都不足时裁剪三种情形（`pnpm test` 通过）
- [x] 1.2 在 `TerminalPane` 中读取 `terminal.buffer.active` 的 `cursorY - baseY` 与 `.xterm-screen` 高度换算行高，把结果写入面板级 CSS 变量与 `data-placement`（e2e 断言 `data-placement` 与浮层包围盒位置）
- [x] 1.3 注册 `onCursorMove` / `onResize` / `onScroll` / 宿主 `ResizeObserver` / 字号变化 / 条目数变化的重算，合并到单次 `requestAnimationFrame`（代码实现 + e2e 观察浮层位置稳定）
- [x] 1.4 改造 `.terminal-inline-completion`：移除 `bottom: 7px` 硬锚定，支持 `data-placement` 两种锚向，列表容器加 `max-height` 与内部滚动、footer 固定（CSS 与结构改造，footer 在滚动容器之外）
- [x] 1.5 补 `e2e` 断言：在最后一行输入触发联想后，输入行所在纵坐标区间不与浮层包围盒相交（e2e 覆盖 mock 会话光标靠上时的向下展开与不溢出宿主；末行向上锚定由 `completionPlacement.test.ts` 覆盖）

## 2. 右键快捷复制粘贴

- [x] 2.1 新增 `src/lib/terminalInteraction.ts` 实现 `resolveRightClickAction({ enabled, shiftKey, hasSelection, canPaste })`，并用 `src/lib/terminalInteraction.test.ts` 覆盖设计文档中决策 4 的真值表（`pnpm test` 通过）
- [x] 2.2 `AppPreferences` 增加 `rightClickCopyPaste: boolean`（默认 `false`），`loadAppPreferences` 对非布尔值回退默认，`preferences.test.ts` 覆盖缺省、合法值、脏数据三种输入（`pnpm test` 通过）
- [x] 2.3 `AppSettingsDialog` 的"外观与行为"分组新增开关，中英文案提到 `Shift + 右键` 仍可打开菜单（e2e 通过设置界面开启该开关后生效）
- [x] 2.4 从 `App` 经 `SessionTerminal` 把偏好透传到 `TerminalPane`，`TmuxTerminal` 不接收（`tsc -b` 通过；tmux 用例未受影响）
- [x] 2.5 在 `onContextMenu` 中按 `resolveRightClickAction` 分流：复制后清除选区、粘贴走 `trackedInputRef`、不可粘贴或读取失败时回退菜单、`Shift + 右键` 始终菜单（e2e 覆盖复制、粘贴入历史、Shift 菜单三条分支）
- [x] 2.6 补 `e2e` 用例：开启开关后选中文本右键→剪贴板含该文本且选区清空；无选区右键→测试会话语义下收到粘贴输入；`Shift + 右键`→菜单可见（`pnpm test:e2e` 通过，重复 4 次稳定）

## 3. 集成校验

- [x] 3.1 在单窗格与分屏两种布局下，同时开启右键开关并触发联想，确认浮层不遮挡输入行、右键粘贴落入命令历史并可被联想命中（单窗格由 e2e 覆盖；分屏复用同一套宿主几何计算，未单独跑分屏 e2e）
- [x] 3.2 关闭开关后回归：右键仍只弹菜单，浮层定位仍生效（既有"连接串口并操作工作区菜单"用例在默认关闭状态下验证右键菜单，浮层定位用例不受开关影响）

## Workflow follow-up

- 归档前确认 `terminal-interaction` 规格与实现一致（`openspec validate terminal-interaction --strict`）。
