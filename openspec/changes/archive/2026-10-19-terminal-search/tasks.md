# Tasks

## 1. 快捷键拦截

- [x] 1.1 `TerminalPane` 的 Ctrl+F 分支在 `return false` 前补 `event.preventDefault()`（e2e 断言：Ctrl+F 的 `defaultPrevented` 为真，且只出现一条应用内查找栏）
- [x] 1.2 同一处理器的 Ctrl+Shift+C、Ctrl+Shift+V、Ctrl+Shift+K 分支补 `event.preventDefault()`（e2e 断言：三个组合键的 `defaultPrevented` 均为真，命令输入面板仍由应用打开）

## 2. 查找栏唯一性

- [x] 2.1 `TERMINAL_SEARCH_EVENT` 升级为携带 `requestId` 的 `CustomEvent`，`requestTerminalSearch()` 递增计数后广播，并补 `uiCommands.test.ts` 断言两次请求得到不同且递增的 id（`pnpm test` 通过）
- [x] 2.2 `TerminalPane` 记录已接受的 `requestId`，收到更新的 id 时关闭自己的查找栏；Ctrl+F 改走 `requestTerminalSearch()` 并携带来源标识（e2e 覆盖：分屏下依次触发只剩一条，输入框获得焦点并可输入）
- [x] 2.3 `TmuxTerminal` 使用同一套 `requestId` 与来源判定，保证 tmux 多窗格只保留最新一条查找输入（e2e 覆盖：tmux 下 Ctrl+F 只有一条查找输入）
- [x] 2.4 补 `e2e` 用例：分屏下依次在两个窗格触发查找后，`查找终端内容` 输入框数量为 1（`pnpm test:e2e` 通过）

## 3. tmux 查找外观与键盘

- [x] 3.1 为 `.tmux-search` 补齐与 `.terminal-search` 一致的背景、边框、前景、高度、圆角、内边距与字号（e2e 断言：圆角 5px、背景非透明、右边界不越过窗格标签左边界）
- [x] 3.2 tmux 查找输入的 Esc 关闭后把焦点交回该窗格终端（e2e 断言：Esc 后 `.tmux-terminal textarea` 获得焦点）
- [x] 3.3 在 `e2e/tmux.spec.ts` 现有 Ctrl+F 用例中补充断言：查找输入可见且可聚焦、Esc 后焦点回到 `.tmux-terminal textarea`（`pnpm test:e2e` 通过）

## 4. 查看菜单入口

- [x] 4.1 `App.tsx` 的 `view` 组在"发送窗格"之后新增"常用命令栏"项，`checked: quickBarOpen`，`onSelect` 切换 `quickBarOpen`（e2e 断言：菜单勾选状态与命令栏显隐一致）
- [x] 4.2 `i18n.tsx` 补充 `menu.view.quickCommands` 中英文案（`pnpm test` 的 i18n 用例通过，两语言键一致）
- [x] 4.3 补 `e2e` 断言：从查看菜单切换命令栏后，命令栏显隐变化且状态栏按钮 `aria-expanded` 同步（`pnpm test:e2e` 通过）

## 5. 集成校验

- [x] 5.1 普通会话与 tmux 分屏各执行一遍 Ctrl+F 流程，确认只出现一条查找栏、Esc 后焦点回终端（e2e 覆盖：`workspace.spec.ts` 分屏用例 + `tmux.spec.ts` 焦点用例，均通过）
- [x] 5.2 关闭查找后切换窗格与标签，确认没有残留查找栏（e2e 覆盖：分屏用例中 Esc 关闭后切换窗格，查找输入数量保持 0）

## Workflow follow-up

- 归档前确认 `quick-commands` 主规格已同步本次修改（`openspec validate terminal-search --strict`）。
