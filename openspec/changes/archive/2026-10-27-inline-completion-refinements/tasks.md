# Tasks

## 1. Tab 永远交给会话，回车接受联想

- [x] 1.1 在 `TerminalPane.tsx` 把联想从 `Tab` 上摘掉：`Tab` 一律落到会话（串口仍发 `\t`），并验证 `pnpm test` 中终端输入相关用例仍通过
- [x] 1.2 新增 `resolveCompletionAcceptAction` 与 `canCompleteFromBuffer` 纯函数承载"显式选中 + 能补齐输入行"的判定，在 `src/lib/terminal.test.ts` 覆盖未选中放行、补齐差集、选中项补不出内容放行三种情况
- [x] 1.3 方向键只在可补齐的候选之间移动，全部不可补齐时把 `↑`/`↓` 还给会话；不可补齐的候选渲染为 `is-static` 并标记 `aria-disabled`，仍可点击打开命令输入框
- [x] 1.4 浮层底部提示改为"↑↓ 选择后回车补全"，中英文案同步到 `src/lib/i18n.tsx`，并在 `src/lib/i18n.test.ts` 断言两处文案
- [x] 1.5 在 `e2e/workspace.spec.ts` 补用例：串口与 shell 会话的 Tab 都原样送出、选中候选后 Tab 仍不改写输入行、回车才补齐、与输入完全一致的首项不可被选中
- [x] 1.6 `Tab` 与接受动作执行时收起浮层，避免压住会话随后打印的补全列表；在 e2e 中断言按 `Tab` 后浮层隐藏、继续输入后重新出现

## 2. 浮层贴输入行上方

- [x] 2.1 扩展 `src/lib/completionPlacement.ts`：返回 `maxHeight`，上方空间不足时压缩而非翻转到下方，翻转仅保留光标首行特例，并在 `src/lib/completionPlacement.test.ts` 覆盖"光标在末行""空间不足压缩""首行翻转"三种输入
- [x] 2.2 在 `TerminalPane.tsx` 用返回的 `maxHeight` 驱动浮层高度上限（与现有 162px 取较小值），候选列表沿用内部滚动，验证高窗口与矮窗口下输入行均不被遮挡
- [x] 2.3 浮层可见期间订阅 `terminal.onRender` 重算位置，并给测量加 `rowHeight <= 0` 回退与 `cursorRow` 夹紧，验证持续输出时光标行移动后浮层仍贴输入行
- [x] 2.4 在 `e2e/workspace.spec.ts` 补"输出填满面板、光标位于末行"的用例，断言 `data-placement="above"` 且浮层下边缘落在光标行上方一行之内

## 3. 历史命令栏显隐

- [x] 3.1 在 `src/lib/workspace.ts` 增加 `historyOpen`（默认 `true`）与读取回退，在 `src/lib/workspace.test.ts` 覆盖"缺字段回退显示""显式隐藏被保留"两种情况
- [x] 3.2 在 `App.tsx` 查看菜单增加历史命令栏勾选项（与常用命令栏项相邻），并通过 `SessionTerminal` 透传 `showHistory`，验证勾选状态与实际显示一致
- [x] 3.3 在 `TerminalPane.tsx` 用 `showHistory` 门禁 `has-history-dock` class 与 `<aside>` 渲染，确认终端内容区宽度、命令输入框与浮层偏移在隐藏后同步回收且无残留条
- [x] 3.4 补充菜单项中英文案到 `src/lib/i18n.tsx`，并在 `docs/06-feature-matrix.md` 记录历史命令栏的显隐入口，验证文档描述与实际菜单一致

## 4. 集成验证

- [x] 4.1 跑通 `pnpm test` 与 `pnpm test:e2e`，确认三条新交互用例与既有终端交互用例全部通过
- [ ] 4.2 在真实串口会话与 shell 会话各手工验证一遍：未选中时 Tab 由会话响应、选中后 Tab 上屏、底部输入行浮层紧贴上方、历史命令栏隐藏后终端占满宽度

## Workflow follow-up

- 按项目评审要求完成评审后归档该 change，并确认归档后 `terminal-interaction` 主 spec 中的定位与键位要求已更新。
