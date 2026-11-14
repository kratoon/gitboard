import type { Board, BoardColumn } from '../core/types';
import type { Placement } from './dnd';

/**
 * Immediately reflects a drag on screen while the server call is in flight. This is presentation only:
 * the server computes the real order and the data is reloaded when the call finishes.
 *
 * If the target group is not shown (for example the hidden "done" group of the backlog) the card simply
 * disappears from its group.
 */
export function moveInColumns(columns: BoardColumn[], id: string, status: string, placement: Placement): BoardColumn[] {
  const moving = columns.flatMap((column) => column.issues).find((issue) => issue.id === id);
  if (!moving) return columns;

  const next = columns.map((column) => ({ ...column, issues: column.issues.filter((issue) => issue.id !== id) }));
  const target = next.find((column) => column.id === status);
  if (!target) return next;

  let index = target.issues.length;
  if (placement.position === 'top') index = 0;
  const anchor = placement.before ?? placement.after;
  if (anchor !== undefined) {
    const at = target.issues.findIndex((issue) => issue.id === anchor);
    if (at >= 0) index = placement.before !== undefined ? at : at + 1;
  }
  target.issues.splice(index, 0, { ...moving, status });
  return next;
}

export function applyMove(boards: Board[], id: string, status: string, placement: Placement): Board[] {
  return boards.map((board) => ({ ...board, columns: moveInColumns(board.columns, id, status, placement) }));
}
