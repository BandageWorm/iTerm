# Proposal

## Why

普通会话里按 Ctrl+F 会出现两条查找栏：应用自己的搜索条，以及 WebView 宿主弹出的原生查找栏。原因是 `TerminalPane` 的 Ctrl+F 分支只 `return false`，xterm 不会替调用方 `preventDefault`，按键继续冒泡触发宿主行为；tmux 分支写了 `event.preventDefault()`，所以只有一条。原生查找栏不在页面 DOM 内，任何样式修复都无效，只能从事件侧拦掉。

同一功能在 tmux control mode 分屏里还有一处退化：`.tmux-search` 只有定位规则、没有任何外观，渲染为原生输入框，在深色终端画布上是刺眼的白块。

另外，常用命令栏的收起/展开目前只有状态栏按钮一个入口，查看菜单里没有对应项，与菜单中已有的"侧栏""发送窗格"不一致。

## What Changes

- 终端内所有自定义快捷键（Ctrl+F、Ctrl+Shift+C/V、Ctrl+Shift+K）调用 `preventDefault()`，不再触发宿主原生查找与原生复制粘贴。
- tmux control mode 的查找输入框与主搜索条共用同一套皮肤（背景、边框、前景、高度、圆角），并补齐 Esc 关闭、Enter 下一个、Shift+Enter 上一个、关闭后回焦的行为。
- 查看菜单新增"常用命令栏"开关项，与状态栏按钮共享同一可见性状态并显示勾选状态。
- 不改搜索匹配逻辑、不加全局搜索栏、不改终端主题变量。

## Capabilities

### New Capabilities

- `terminal-search`: 终端查找栏的呈现与快捷键契约：全局唯一一条查找栏、快捷键不得触发宿主查找、普通会话与 tmux 分屏共用同一套外观与键盘行为。

### Modified Capabilities

- `quick-commands`: "命令栏的收起与展开"需求补充查看菜单入口，使开关不再只存在于状态栏。

## Impact

- `src/components/TerminalPane.tsx`：快捷键处理补 `preventDefault`。
- `src/components/SessionTerminal.tsx`：tmux 查找输入的键盘行为与关闭回焦。
- `src/styles.css`：`.tmux-search` 与 `.terminal-search` 共用皮肤 token。
- `src/App.tsx`：查看菜单项与 `quickBarOpen` 绑定。
- `src/lib/i18n.tsx`：新增菜单项中英文案。
- `e2e/workspace.spec.ts`：查找栏唯一性与键盘默认行为被阻止的断言。
- 不涉及持久化结构变更。
