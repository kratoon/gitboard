import { useState, type PointerEvent, type ReactNode } from 'react';
import type { Column, EpicChild, EpicColumnId } from '../core/types';
import { LinkedText, internalClick, useLinks } from './links';

const LABELS: Record<EpicColumnId, string> = { ref: 'Ref', title: 'Title', status: 'Status', priority: 'Priority', labels: 'Labels' };
const DEFAULT_WIDTH: Record<EpicColumnId, number> = { ref: 130, title: 340, status: 140, priority: 100, labels: 200 };
const MIN_WIDTH = 60;
const storageKey = (id: EpicColumnId) => `gitboard.epicColumn.${id}`;

function loadWidth(id: EpicColumnId): number {
  try {
    const stored = Number(localStorage.getItem(storageKey(id)));
    return Number.isFinite(stored) && stored >= MIN_WIDTH ? stored : DEFAULT_WIDTH[id];
  } catch {
    return DEFAULT_WIDTH[id];
  }
}

/**
 * The child issues of an epic as a table. Columns come from the repository config. A column's width is
 * changed by dragging the edge of its header, and the table scrolls sideways when it gets wider than the
 * page; widths are remembered in the browser (not in the repository).
 */
export function EpicChildren({ items, columns, statuses }: { items: EpicChild[]; columns: EpicColumnId[]; statuses: Column[] }) {
  const links = useLinks();
  const [widths, setWidths] = useState<Record<string, number>>({});
  const widthOf = (id: EpicColumnId) => widths[id] ?? loadWidth(id);

  const startResize = (id: EpicColumnId) => (event: PointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = widthOf(id);
    let latest = startWidth;
    const move = (e: globalThis.PointerEvent) => {
      latest = Math.max(MIN_WIDTH, Math.round(startWidth + e.clientX - startX));
      setWidths((current) => ({ ...current, [id]: latest }));
    };
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
      try {
        localStorage.setItem(storageKey(id), String(latest));
      } catch {
        /* storage can be unavailable; the width then lasts until reload */
      }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  };

  return (
    <div className="children-scroll">
      <table className="children-table" style={{ width: columns.reduce((sum, id) => sum + widthOf(id), 0) }}>
        <colgroup>
          {columns.map((id) => (
            <col key={id} style={{ width: widthOf(id) }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((id) => (
              <th key={id}>
                {LABELS[id]}
                <span className="col-resizer" role="separator" aria-orientation="vertical" aria-label={`Resize ${LABELS[id]} column`} onPointerDown={startResize(id)} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((child) => {
            const path = links?.resolve(child.ref)?.path ?? null;
            const cell: Record<EpicColumnId, ReactNode> = {
              ref:
                path !== null && links ? (
                  <a className="ref issue-ref" href={path} onClick={internalClick(links, path)}>{child.ref}</a>
                ) : (
                  <span className="ref">{child.ref}</span>
                ),
              title: <LinkedText text={child.title} />,
              status: <span className="chip nowrap">{statuses.find((c) => c.id === child.status)?.name ?? child.status}</span>,
              priority: child.priority ? <span className={`badge priority-${child.priority}`}>{child.priority}</span> : null,
              labels:
                child.labels.length > 0 ? (
                  <div className="chip-row">
                    {child.labels.map((label) => (
                      <span key={label} className="chip nowrap">{label}</span>
                    ))}
                  </div>
                ) : null,
            };
            return (
              <tr key={child.id}>
                {columns.map((id) => (
                  <td key={id} className={`col-${id}`}>{cell[id]}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
