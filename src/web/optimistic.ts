import type { Board } from '../core/types';
import type { Placement } from './Board';

/**
 * Immediately reflects a drag on screen while the server call is in flight. This is presentation only:
 * the server computes the real order and the board is reloaded when the call finishes.
 */
export function applyMove(boards: Board[], id: string, status: string, placement: Placement): Board[] {
  return boards.map((board) => {
    const source = board.columns.find((column) => column.issues.some((issue) => issue.id === id));
    if (!source) return board;
    const moving = source.issues.find((issue) => issue.id === id);
    if (!moving) return board;

    const columns = board.columns.map((column) => ({ ...column, issues: column.issues.filter((issue) => issue.id !== id) }));
    const target = columns.find((column) => column.id === status);
    if (!target) return board;

    let index = target.issues.length;
    if (placement.position === 'top') index = 0;
    const anchor = placement.before ?? placement.after;
    if (anchor !== undefined) {
      const at = target.issues.findIndex((issue) => issue.id === anchor);
      if (at >= 0) index = placement.before !== undefined ? at : at + 1;
    }
    target.issues.splice(index, 0, { ...moving, status });
    return { ...board, columns };
  });
}
