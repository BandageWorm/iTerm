# terminal-search Specification

## Purpose

定义终端查找功能的入口、快捷键与呈现契约：同一时间只允许一条由应用提供的查找栏，快捷键不得触发宿主程序的查找或复制粘贴，普通会话与 tmux control mode 分屏使用同一套外观与键盘行为。

## Requirements

### Requirement: 查找栏由应用提供且全局唯一
终端查找 MUST 由应用自身的查找栏承载，同一时间 SHALL 最多存在一条可见的查找栏。在分屏或多标签布局中，每次触发查找 SHALL 关闭此前打开的查找栏，只保留最近一次触发所对应的那一条。关闭查找后 SHALL NOT 在其它窗格留下残留的查找栏。

#### Scenario: 普通会话触发查找
- **WHEN** 用户在普通终端会话中按 Ctrl+F
- **THEN** 只出现一条应用内查找栏，输入框获得焦点

#### Scenario: 分屏中依次触发查找
- **WHEN** 用户在一个窗格打开查找栏，随后在另一个窗格再次按 Ctrl+F
- **THEN** 只保留后一次打开的查找栏，先前窗格的查找栏关闭

#### Scenario: 关闭后无残留
- **WHEN** 用户关闭当前查找栏后切换窗格
- **THEN** 目标窗格不出现任何查找栏

### Requirement: 自定义快捷键不得触发宿主默认行为
终端内由应用接管的快捷键 SHALL 阻止按键的默认行为，`Ctrl+F` MUST NOT 触发宿主（WebView）的原生查找栏，`Ctrl+Shift+C` / `Ctrl+Shift+V` / `Ctrl+Shift+K` MUST NOT 触发宿主或操作系统的原生复制粘贴等默认动作。

#### Scenario: Ctrl+F 不出现原生查找栏
- **WHEN** 用户在终端焦点下按 Ctrl+F
- **THEN** 该按键事件的默认行为被阻止，页面只出现应用内查找栏

#### Scenario: 复制粘贴组合键不叠加原生行为
- **WHEN** 用户按 Ctrl+Shift+C 或 Ctrl+Shift+V
- **THEN** 只有应用自身的复制或粘贴生效，宿主不执行原生复制粘贴

### Requirement: tmux 分屏的查找输入与主查找栏一致
tmux control mode 分屏中的查找输入 SHALL 与普通会话的查找栏使用同一套外观（背景、边框、文字颜色、高度与圆角），并 MUST 保持可读，不得呈现为宿主原生输入框样式。其键盘行为 SHALL 与主查找栏一致：`Esc` 关闭并把焦点交回终端，`Enter` 跳到下一个匹配，`Shift+Enter` 跳到上一个匹配。

#### Scenario: 深色终端下的外观
- **WHEN** 用户处于深色终端配色的 tmux 分屏中按 Ctrl+F
- **THEN** 查找输入呈现应用统一的查找栏外观，文字与底色对比可读，不出现原生白框

#### Scenario: Esc 关闭并回焦终端
- **WHEN** tmux 分屏的查找输入获得焦点，用户按 Esc
- **THEN** 查找输入消失，焦点回到该窗格的终端

#### Scenario: 回车切换匹配
- **WHEN** tmux 分屏的查找输入中有内容，用户按 Enter 或 Shift+Enter
- **THEN** 分别跳转到下一个或上一个匹配项
