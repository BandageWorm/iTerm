export type RightClickAction = "copy" | "paste" | "menu";

export interface RightClickContext {
  /** 应用设置里"右键触发复制粘贴"是否开启。 */
  enabled: boolean;
  /** 事件是否按下了 Shift（保留原上下文菜单的逃逸键）。 */
  shiftKey: boolean;
  /** 终端当前是否存在选区。 */
  hasSelection: boolean;
  /** 当前会话是否允许写入（已连接且未在传输文件）。 */
  canPaste: boolean;
}

/**
 * 决定终端内右键应当执行的动作。
 * 关闭开关或按住 Shift 时始终回退到上下文菜单；
 * 无法粘贴（未连接/传输中）时同样回退，保证菜单仍然可达。
 */
export function resolveRightClickAction({
  enabled,
  shiftKey,
  hasSelection,
  canPaste,
}: RightClickContext): RightClickAction {
  if (!enabled || shiftKey) return "menu";
  if (hasSelection) return "copy";
  return canPaste ? "paste" : "menu";
}
