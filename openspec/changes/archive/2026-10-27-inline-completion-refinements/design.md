# Design

## Context

参见 `proposal.md`（Why）。影响方案实现的现有约束：

- 内联联想的按键裁决集中在 `TerminalPane.tsx` 的 `attachCustomKeyEventHandler` 单一回调里，顺序固定：快捷键 → 浮层（`↑`/`↓`/`Esc`/`Tab`）→ 串口 Tab 透传 → 特殊键映射 → 交给 pty。浮层的 Tab 分支当前在"没有显式选中"时也会用首项尝试补齐。
- 浮层位置由纯函数 `resolveCompletionPlacement` 计算，输入是 `rows`、`rowHeight`（`.xterm-screen` 高度除以行数）、`cursorRow` 和实测浮层高度；输出只有 `placement` 与 `offset`，没有高度约束。翻转条件为"上方空间 < 浮层高度"，翻转后 `offset` 被夹紧到 `paneHeight - popupHeight - margin`，因此底部输入行会落到面板顶部。
- `cursorRow` 的取值是错的：xterm 的 `buffer.active.cursorY` 本身已是视口相对行号（类型注释写明 0 表示光标位于 `baseY` 那一行），而代码又减了一次 `baseY`。缓冲区一旦滚动（`baseY > 0`）就得到负值并被夹到 0，浮层始终以为光标在首行——这是"底部输入行时浮层跑到面板顶部"的直接原因，与测量时机无关。
- 浮层位置只在 `suggestionCount` 变化时挂载一次，之后靠 `onCursorMove` / `onResize` / `onScroll` 触发重算，没有订阅渲染帧。
- 历史命令栏在 `TerminalPane` 里以 `active ? "has-history-dock" : ""` 无条件生效，没有开关；终端内容区宽度、命令输入框右偏移、浮层右偏移都挂在同一个 class 上。
- 工作区可见性状态已有持久化通道：`WorkspaceSnapshot`（`sidebarOpen` / `senderOpen` / `quickBarOpen`），由 `App.tsx` 在查看菜单里切换。

## Goals / Non-Goals

**Goals:**

- 让 `Tab` 完全归会话所有，且"想补全"的路径仍然只要一次方向键加一次回车。
- 让补不出内容的候选不参与键盘选择，避免接受键被白吞。
- 让浮层在底部输入行时紧贴输入行上方，高度不足时压缩而不是逃离。
- 让浮层位置在终端持续输出时不依赖过期测量。
- 让历史命令栏可显隐，且不引入第二套宽度协调逻辑。

**Non-Goals:**

- 不改变 `↑`/`↓` 的导航语义本身（仍是浮层导航，`Esc` 仍是唯一逃逸路径）；只收窄可选范围到"可补齐"的候选。
- 不引入"用快捷键武装浮层"的新交互模型，也不新增设置页开关。
- 不改动联想的数据来源、匹配与排序规则（仍由 `quick-commands` 与命令历史决定）。
- 不改动分屏与 tmux control mode 下历史栏"不显示"的既有行为。

## Decisions

### 1. Tab 永不消费，回车承担接受动作

联想完全不参与 `Tab` 的裁决：串口会话继续把 `Tab` 当制表符送出，其他会话直接落到 pty。接受动作交给回车，条件是"已显式选中 + 该候选能把输入行继续补齐"（`resolveCompletionAcceptAction`）。已选中的索引在可打印字符、退格、回车、`Esc` 时都会被重置，所以语义是"每次改输入都要重新确认一次选择"。

这条是实测收敛的结果：先做的版本是"选中后 Tab 上屏"，真机试用时输入 `i`、按下 `↓` 会选中与输入完全一致的 `i`，补不出任何字符，Tab 依然落到 shell——用户看到的是"选中了按 Tab 却没上屏"。与其在 Tab 上继续加例外，不如把这个键彻底交还给会话，接受键换成会话本来就要用的回车。

为此还定了两条配套约束：

- 方向键只在**可补齐**的候选之间移动（`canCompleteFromBuffer`）；否则回车被牺牲掉却补不出内容，用户连命令都执行不了。不可补齐的候选弱化为 `is-static` 并标记 `aria-disabled`，仍可点击打开命令输入框。
- 没有可补齐候选时，`↑`/`↓` 直接还给会话，历史召回不受影响。
- `Tab` 与接受动作都会把浮层收起。这不是随手加的：真机上按 `Tab` 后 shell 会把候选目录/文件名按列打印出来，浮层留在原地正好压住这张列表——"Tab 归会话"只解决键的归属，不解决视野被挡。

- 备选一（**放弃**）：`Tab` 仅在显式选中后接受。已在真机上被上述完全一致的候选场景否决。
- 备选二（**放弃**）：新增 `Tab 接受联想` 设置项。全局开关解决不了"有时候"，且与本次想消除的歧义无关。
- 备选三（**放弃**）：用行尾 `→` 接受。与光标移动混淆，且 `→` 在 shell 里同样有语义。
- 备选四（**放弃**）：浮层纯被动，用 `Ctrl+Space` 武装键盘导航。需要新快捷键与状态机，超出本次范围。

浮层底部提示从 `Up/Down` + `Tab` 改为"↑↓ + 选择后回车补全"，否则用户无从得知接受键已经换人。

### 2. 定位改为"贴上方 + 限高"，翻转只保留首行特例

`resolveCompletionPlacement` 的返回值增加 `maxHeight`，判定顺序改为：

```
availableAbove = cursorTop - gap - margin
   |
   +-- availableAbove >= minVisible  --> above，maxHeight = min(availableAbove, 162)
   |
   +-- 否则（光标贴首行）           --> below，maxHeight = min(面板下方可用空间, 162)
```

取消"翻转后夹紧到面板顶部"的路径——那正是浮层跑到面板顶部的直接原因。压缩后的高度写成 CSS 变量作用在候选列表上，让它沿用已有的内部滚动（`.terminal-inline-completion-list` 已有 `max-height: 162px; overflow: auto`），取两者较小值，避免浮层在矮面板里比原先更高。

- 备选（**放弃**）：保留翻转，但在底部输入行时改为"贴面板顶并显示更多项"。这正是要修的观感，明确不做。
- 备选（**放弃**）：翻转时保持浮层高度、允许遮住输入行。违反既有 spec 的"输入行始终可见"。

`minVisible` 取"一条候选 + 底部提示"的高度：低于这个值浮层没有信息价值，不如翻到下方。

### 3. 修正光标行坐标，并让测量跟着渲染走

先修坐标语义：`cursorRow` 直接取 `buffer.cursorY`（已含视口偏移语义），不再减 `baseY`。这一条修好，滚动后的底部输入行才会被判成"最后一行"。

再让测量贴合渲染：浮层可见期间额外订阅 `terminal.onRender`，与既有的 `onCursorMove` / `onResize` / `onScroll` 共用同一个 rAF 去抖函数，输出持续写入导致的光标行变化不会留下过期锚点。

同时对该函数的输入做守卫：`rowHeight <= 0` 时回退到 `hostRect.height / rows`，`cursorRow` 夹在 `[0, rows - 1]`。这两条让"测量发生在输出铺屏之前"退化为轻微偏移，而不是把浮层放到面板另一头。

- 备选（**放弃**）：改用 xterm 私有 `_core._renderService.dimensions` 拿精确 cell 尺寸。更准，但依赖私有 API，升级 xterm 6 后会静默失效。
- 备选（**放弃**）：用 `.xterm-cursor` DOM 元素量光标矩形。webgl 渲染器下不存在该元素（本项目使用 `WebglAddon`）。

订阅范围限定在 `suggestionCount > 0` 期间，浮层关闭即释放，避免空转测量。

### 4. 历史命令栏复用工作区快照，只门禁一个 class

新增 `historyOpen`（默认 `true`）到 `WorkspaceSnapshot`，`App.tsx` 在查看菜单里切换并由现有快照持久化通道保存，通过 `SessionTerminal` 已有的 props 透传链交给 `TerminalPane` 的 `showHistory`。**只门禁 `has-history-dock` class 与 `<aside>` 渲染**：终端内容区右偏移、命令输入框右偏移、浮层右偏移都挂在该 class 上，改一处即可整体回收宽度，不必逐条同步。

- 备选（**放弃**）：放进 `AppPreferences` 的设置页。它是布局可见性而非行为偏好，与 `sidebarOpen` / `senderOpen` 同类，放在设置页会让两套可见性状态来源分裂。
- 备选（**放弃**）：做成每窗格独立状态。菜单是全局入口，且分屏下历史栏本来就不显示，独立状态没有可观察差异，只会增加状态面。

## Risks / Trade-offs

- [`Enter` 从"执行命令"变成"可能只补全"，若接受条件判断失误会吞掉执行] → 接受仅在"显式选中 + 候选可补齐"时发生；选中项补不出内容时一律放行，且可由纯函数单测覆盖。
- [`Tab` 不再上屏，老用户可能找不到接受键] → 浮层底部提示改为"↑↓ / 选择后回车补全"，选中项保持高亮反馈。
- [`↑`/`↓` 仍被浮层占用，浮层打开时 shell 历史召回失效] → 收窄为只在存在可补齐候选时占用；无可补齐候选时直接还给会话，`Esc` 仍是逃逸路径。
- [`onRender` 每帧触发测量带来开销] → 仅浮层可见时订阅，rAF 合并，`setState` 前比较新旧值避免无谓重渲染。
- [压缩高度后同时可见的候选变少] → 符合既有 spec 的"限高 + 内部滚动"，且矮面板本来也放不下全部候选。
- [隐藏历史命令栏触发 fit 重排，远端 PTY 收到 resize] → 与侧边栏显隐一致，属预期行为；分屏与 tmux 场景不受影响。
- [工作区快照缺字段] → 缺省回退 `true`，老用户升级后行为不变。

## Migration Plan

无数据结构迁移。旧的 `iterm.workspace.v1` 快照中缺少 `historyOpen` 时按 `true` 处理，无需重写存储；回滚只需恢复渲染门禁，快照中多出的字段对旧版本无影响。
