# Tasks

## 1. 数据层：常用命令库

- [x] 1.1 新建 `src/lib/quickCommands.ts`（`QuickCommand` 类型、条数与长度上限常量、load/save、新增/更新/删除/左移右移/按内容去重收藏），并新增 `src/lib/quickCommands.test.ts` 覆盖读取容错、50 条上限、4096 字符截断、去重与顺序持久化；验证：`pnpm test` 通过
- [x] 1.2 `src/lib/workspace.ts` 的 `WorkspaceSnapshot` 新增 `quickBarOpen`（默认 `true`，非布尔值兜底），并扩充 `src/lib/workspace.test.ts` 覆盖缺字段与非法值；验证：`pnpm test` 通过
- [x] 1.3 `src/lib/commandHistory.ts` 的 `buildCommandSuggestions` 第三参由 `SenderPreset[]` 改为 `QuickCommand[]`（含 `source: "quick"` 的行尾类型），同步更新 `src/lib/commandHistory.test.ts`；验证：`pnpm test` 通过
- [x] 1.4 `src-tauri/src/storage.rs` 的 `ALLOWED_STORAGE_KEYS` 加入 `iterm.quick-commands.v1`（数组长度同步改为 7），避免 `validate_key` 拒绝该键并弹出“不允许持久化配置项”；验证：`cargo check` 通过，且在重启后的桌面应用里保存常用命令不再出现该提示

## 2. 命令栏组件

- [x] 2.1 新建 `src/components/QuickCommandBar.tsx`：命令按钮（点击发送）、末尾 `+` 新增入口、右键菜单（发送 / 编辑 / 复制一份 / 左移 / 右移 / 删除）、就地编辑浮层（名称 / 内容 / 行尾 / 保存 / 取消 / 删除），为栏、菜单与浮层提供 `role` 与中英 `aria-label`，并补齐 `quick.commands.*` i18n 文案；验证：`pnpm build` 类型检查通过，且中英两张文案表都含新增键
- [x] 2.2 `src/styles.css` 新增命令栏、右键菜单与编辑浮层样式（32px 高、横向滚动且隐藏滚动条、禁用态、亮暗主题各一套变量）；验证：`pnpm dev` 下亮色与暗色主题各目视一次，命令较多时横向滚动且不换行、不被终端内容遮挡
- [x] 2.3 在 `src/App.tsx` 挂载命令栏（位于终端栈之后、发送窗格之前，作为 `.main-area` 的 flex 行），持有命令库与可见性状态，点击经 `writeTerminalInput(activeSession, activeProfile, payload + commandLineEnding(...))` 发送；验证：`pnpm dev` 下点击命令后状态栏 TX 计数增加，命令历史面板不新增记录

## 3. 可见性、收起与布局

- [x] 3.1 状态栏右下角新增命令栏收起/展开开关（与“发送”按钮并列，独立状态，含中英 `aria-label`），写入 `quickBarOpen`；验证：`pnpm test:e2e` 中断言收起后命令栏不可见、开关仍可点击，刷新页面后保持收起
- [x] 3.2 命令栏在分屏与 tmux control mode 下保持单条可见，无会话时按钮禁用；验证：e2e 用例开启分屏后断言命令栏仍存在且只有一条，并断言无会话时按钮为禁用态
- [x] 3.3 在 `src/styles.css` 的 `.app-shell.is-focus-mode` 规则中加入命令栏；验证：手动进入专注模式后命令栏隐藏，退出后恢复进入前的可见状态

## 4. 历史收藏与联想联动

- [x] 4.1 `src/components/TerminalPane.tsx` 的历史面板条目增加收藏按钮（已收藏显示为已收藏状态），调用去重收藏；验证：`pnpm test:e2e` 中从历史收藏后命令栏出现该命令，再次收藏不新增重复项
- [x] 4.2 `TerminalPane` 的内联联想 quick 源改为 `loadQuickCommands()`，并在打开命令输入器时刷新；验证：手动在终端输入常用命令名称前缀与内容前缀，两种匹配都能在联想列表中列出该命令

## 5. 移除窗格内快捷栏

- [x] 5.1 删除 `TerminalPane` 中旧栏的 JSX、`has-quickbar` class 与 `onOpenSender` 属性，并移除 `src/App.tsx` 的对应传参；验证：`pnpm build` 通过，且 `rg "onOpenSender|has-quickbar" src` 无结果
- [x] 5.2 删除 `src/styles.css` 中旧栏样式与全部终端偏移规则，删除 i18n 的 `terminal.quickbar.title` 与 `terminal.quickbar.configure`（中英各一份）；验证：`rg "terminal-quickbar|has-quickbar|terminal\.quickbar" src` 无结果，`pnpm test` 与 `pnpm build` 通过
- [x] 5.3 更新 `CHANGELOG.md`，说明窗格内快捷栏由全局常用命令栏取代、快捷命令不再等同于发送预设（旧发送预设不自动迁移）、命令栏发送不写入命令历史；验证：新条目覆盖以上三点

## 6. 集成验证

- [x] 6.1 扩展 `e2e/workspace.spec.ts` 覆盖跨特性交互：分屏下点击命令发送到获得焦点的窗格，以及收起命令栏与收起发送窗格互不影响；验证：`pnpm test:e2e` 通过
- [x] 6.2 回归检查：`pnpm test`、`pnpm build`、`pnpm test:e2e` 全部通过，且 `openspec validate add-quick-command-bar --strict` 无错误；验证：三条命令退出码为 0，校验命令无报错

## Workflow follow-up

- 按项目评审要求完成 review 后归档本变更。
- 归档后核对归档结果（`openspec/specs/quick-commands/spec.md` 的 Purpose 与需求文本正确合并）。
- 后续可选的独立变更：提供“从现有发送预设一次性导入常用命令”的入口（本变更刻意不自动迁移）。
