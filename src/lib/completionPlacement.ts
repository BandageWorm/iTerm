export type CompletionPlacement = "above" | "below";

export interface CompletionPlacementInput {
  /** 终端行数（`terminal.rows`）。 */
  rows: number;
  /** 单行像素高度，由 `.xterm-screen` 高度除以行数得到。 */
  rowHeight: number;
  /** 光标所在的可视行号（`buffer.active.cursorY - buffer.active.baseY`）。 */
  cursorRow: number;
  /** 终端宿主的可视高度（px）。 */
  paneHeight: number;
  /** 浮层与光标行之间的间隙，默认 4。 */
  gap?: number;
  /** 浮层与宿主上/下边缘的最小距离，默认 4。 */
  margin?: number;
  /** 浮层整体的最大高度（列表上限 + 底部提示），默认 188。 */
  maxVisibleHeight?: number;
  /** 低于该高度浮层已无信息价值，不如翻到另一侧，默认 56。 */
  minVisibleHeight?: number;
}

export interface CompletionPlacementResult {
  placement: CompletionPlacement;
  /**
   * `above` 时为宿主底边到浮层底边的距离；
   * `below` 时为宿主顶边到浮层顶边的距离。
   */
  offset: number;
  /** 该位置下浮层允许的最大高度，超出部分在浮层内部滚动。 */
  maxHeight: number;
}

/**
 * 把内联联想浮层贴到光标行的上一行，保证用户正在输入的那一行始终可见。
 * 上方放不下时压缩高度而不是翻到下方——翻转只保留光标贴首行的特例，
 * 否则底部输入行会把浮层顶到面板另一端。
 */
export function resolveCompletionPlacement({
  rows,
  rowHeight,
  cursorRow,
  paneHeight,
  gap = 4,
  margin = 4,
  maxVisibleHeight = 188,
  minVisibleHeight = 56,
}: CompletionPlacementInput): CompletionPlacementResult {
  const safeRows = Math.max(1, Math.floor(rows));
  const safeRowHeight = Math.max(1, rowHeight);
  const safePaneHeight = Math.max(1, paneHeight);
  const safeGap = Math.max(0, gap);
  const safeMargin = Math.max(0, margin);
  const safeMaxHeight = Math.max(0, maxVisibleHeight);
  const safeMinHeight = Math.max(0, minVisibleHeight);

  const row = Math.min(
    Math.max(0, Math.floor(cursorRow)),
    safeRows - 1,
  );
  const cursorTop = row * safeRowHeight;
  const cursorBottom = cursorTop + safeRowHeight;

  const spaceAbove = cursorTop - safeGap - safeMargin;
  const spaceBelow = safePaneHeight - (cursorBottom + safeGap) - safeMargin;

  if (spaceAbove >= safeMinHeight) {
    return {
      placement: "above",
      offset: Math.round(safePaneHeight - cursorTop + safeGap),
      maxHeight: Math.round(Math.min(spaceAbove, safeMaxHeight)),
    };
  }

  if (spaceBelow >= safeMinHeight) {
    return {
      placement: "below",
      offset: Math.round(cursorBottom + safeGap),
      maxHeight: Math.round(Math.min(spaceBelow, safeMaxHeight)),
    };
  }

  // 两侧都放不下（面板本身太矮）：贴在空间更大的一侧，按该侧空间限高。
  return spaceAbove >= spaceBelow
    ? {
        placement: "above",
        offset: Math.round(safePaneHeight - cursorTop + safeGap),
        maxHeight: Math.round(Math.min(Math.max(0, spaceAbove), safeMaxHeight)),
      }
    : {
        placement: "below",
        offset: Math.round(cursorBottom + safeGap),
        maxHeight: Math.round(Math.min(Math.max(0, spaceBelow), safeMaxHeight)),
      };
}
