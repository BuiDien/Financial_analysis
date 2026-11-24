// Lucian UX/UI Prompt #227 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#227
// Sortable data table: press a header and the rows slide past each other into the new order while the
// sort arrow spins; rows that newly arrive glow briefly (highlightNew). Real <table>, sticky header,
// numeric columns right-aligned in the mono face.
//
// <DataTable
//   columns={[{ key, label, numeric?, align?: 'left'|'right', sortable?: true, sortValue?(row),
//               render?(row, index), width?, className?, headerClassName?, headerTitle? }]}
//   rows rowKey="id" | (row) => key
//   onRowClick?(row)  selectedKey?
//   sort?={{ key, dir: 'asc'|'desc' }} defaultSort? onSortChange?(sort)   (controlled or not)
//   dense? maxHeight? loading? skeletonRows=5 empty?="No rows" highlightNew? ariaLabel caption?
//   stickyFirstColumn? rowTitle?(row) footer? groupBy? renderExpanded?(row) … />
// Additions (all optional, off by default):
// - column.minWidth: min width of the column (px number or CSS length).
// - stickyFirstColumn: the first data column stays pinned while the table scrolls sideways.
// - rowTitle(row): a tooltip / accessible description on each row (the <tr> title).
// - footer: a totals row in <tfoot>, sticky at the bottom inside maxHeight. Either an object keyed by
//   column key ({ value: '512M ₫' }) or an array in column order. Numeric columns align like the body.
// - groupBy: 'field' | (row) => label. Rows are grouped under full-width header rows in order of first
//   appearance; sorting applies inside each group. Or put marker items in `rows`: an object whose only
//   keys are `group` (+ optional `meta`, `key`), e.g. { group: 'Banks', meta: '3' }, starts a group.
// - renderExpanded(row): adds a leading toggle column; the toggle (a real button with aria-expanded)
//   opens a full-width detail row under the row. canExpand?(row) hides the toggle per row. Expansion
//   is uncontrolled (defaultExpandedKeys) or controlled (expandedKeys + onExpandedChange(keys[])).
//   expandOnRowClick: a row click (when there is no onRowClick) toggles it too.
// Sorting compares sortValue(row) ?? row[key]: numbers (and number-like strings such as "1,234 ₫",
// "+1.2%", "3.4B") numerically, text with localeCompare; empty values always sort last. Keep raw
// numbers in row[key] and format in render (or pass sortValue). Pass sortable:false per column, or sortable={false} for the whole table.

import React from 'react';
import { cx, useReducedMotion } from './util.js';
import { Skeleton } from './Skeleton.jsx';
import { sortRows } from './sort.js';
import { groupRows, isGroupMarker } from './logic.js';
import './table.css';

const GLIDE_MAX = 100;
const cssLen = (v) => (typeof v === 'number' ? `${v}px` : v);

const Chevron = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 3l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

const Arrow = () => (
  <svg viewBox="0 0 9 9" aria-hidden="true"><path d="M2 3.5l2.5 2.5L7 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

const DataTable = ({
  columns = [], rows = [], rowKey = 'id', onRowClick, selectedKey, sort: sortProp, defaultSort = null, onSortChange,
  sortable = true, dense = false, maxHeight, loading = false, skeletonRows = 5, empty = 'No rows', highlightNew = false,
  ariaLabel, caption, className, rowClassName,
  stickyFirstColumn = false, rowTitle, footer, groupBy, renderExpanded, canExpand, expandedKeys: expandedProp,
  defaultExpandedKeys, onExpandedChange, expandOnRowClick = false,
}) => {
  const reduced = useReducedMotion();
  const [sortState, setSortState] = React.useState(defaultSort);
  const sort = sortProp !== undefined ? sortProp : sortState;
  const keyOf = React.useCallback((r, i) => (typeof rowKey === 'function' ? rowKey(r, i) : r?.[rowKey] ?? `i${i}`), [rowKey]);

  const hasMarkers = React.useMemo(() => rows.some(isGroupMarker), [rows]);
  const dataRows = React.useMemo(() => (hasMarkers ? rows.filter(r => !isGroupMarker(r)) : rows), [rows, hasMarkers]);
  // Rows keep their original index so a missing key field still gives a stable identity.
  const indexOf = React.useMemo(() => new Map(dataRows.map((r, i) => [r, i])), [dataRows]);
  const sortSeg = React.useCallback((list) => {
    if (!sort || !sort.key) return list;
    const col = columns.find(c => c.key === sort.key);
    if (!col) return list;
    return sortRows(list, (r) => (col.sortValue ? col.sortValue(r) : r?.[col.key]), sort.dir);
  }, [columns, sort]);
  // Groups: [{ label, meta, key, rows }] (null when the table is not grouped).
  const groups = React.useMemo(() => (hasMarkers || groupBy ? groupRows(rows, groupBy, sortSeg) : null), [rows, hasMarkers, groupBy, sortSeg]);
  const sorted = React.useMemo(() => (groups ? groups.flatMap(g => g.rows) : sortSeg(rows)), [groups, rows, sortSeg]);

  // Expansion (controlled through expandedKeys, else internal).
  const [expState, setExpState] = React.useState(() => new Set((defaultExpandedKeys || []).map(String)));
  const expanded = expandedProp !== undefined ? new Set((expandedProp || []).map(String)) : expState;
  const toggleExpand = (k) => {
    const next = new Set(expanded);
    if (next.has(k)) next.delete(k); else next.add(k);
    if (expandedProp === undefined) setExpState(next);
    onExpandedChange?.([...next]);
  };

  const setSort = (key) => {
    const next = !sort || sort.key !== key ? { key, dir: 'desc' } : { key, dir: sort.dir === 'desc' ? 'asc' : 'desc' };
    if (sortProp === undefined) setSortState(next);
    onSortChange?.(next);
  };

  // FLIP glide: remember each row's offsetTop; after a re-order, start each moved row at its old
  // place and let it transition home. New keys (after the first paint) get the arrival glow.
  const bodyRef = React.useRef(null);
  const tops = React.useRef(null);
  const sortSig = sort ? `${sort.key}:${sort.dir}` : '';
  const lastSig = React.useRef(sortSig);
  React.useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const trs = Array.from(body.querySelectorAll('tr[data-k]'));
    const prev = tops.current;
    const next = new Map();
    const glide = !reduced && prev && lastSig.current !== sortSig && trs.length <= GLIDE_MAX;
    trs.forEach(tr => {
      const k = tr.dataset.k, top = tr.offsetTop;
      next.set(k, top);
      if (glide && prev.has(k) && prev.get(k) !== top) {
        tr.classList.remove('is-glide');
        tr.style.transform = `translateY(${prev.get(k) - top}px)`;
        void tr.offsetWidth;
        tr.classList.add('is-glide');
        tr.style.transform = '';
      } else if (highlightNew && prev && !prev.has(k) && !reduced && !k.endsWith('::x')) {
        tr.classList.remove('is-new'); void tr.offsetWidth; tr.classList.add('is-new');
      }
    });
    tops.current = loading ? prev : next;
    lastSig.current = sortSig;
  });

  const expandable = typeof renderExpanded === 'function';
  const colCount = (columns.length || 1) + (expandable ? 1 : 0);
  const alignOf = (c) => c.align || (c.numeric ? 'right' : 'left');
  const colStyle = (c) => (c.width || c.minWidth ? { ...(c.width ? { width: c.width } : null), ...(c.minWidth ? { minWidth: cssLen(c.minWidth) } : null) } : undefined);
  const footCells = footer == null ? null : Array.isArray(footer) ? columns.map((_, j) => footer[j]) : columns.map(c => footer[c.key]);
  const renderRow = (r, i) => {
    const k = String(keyOf(r, indexOf.get(r) ?? i));
    const canX = expandable && (!canExpand || canExpand(r));
    const isOpen = canX && expanded.has(k);
    const click = onRowClick ? () => onRowClick(r) : (canX && expandOnRowClick ? () => toggleExpand(k) : undefined);
    // A clickable row is focusable: onRowClick, or expandOnRowClick (Enter/Space toggles it).
    const focusRow = !!click;
    const detailId = `${String(ariaLabel || 'dt').replace(/[^a-zA-Z0-9_-]/g, '_')}-x-${k.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const out = [
      <tr key={k} data-k={k} className={cx(click && 'is-click', selectedKey != null && String(selectedKey) === k && 'is-selected', isOpen && 'is-open', rowClassName?.(r, i))}
        title={rowTitle ? (rowTitle(r) || undefined) : undefined}
        onClick={click} tabIndex={focusRow ? 0 : undefined} aria-expanded={!onRowClick && canX && expandOnRowClick ? isOpen : undefined}
        onKeyDown={focusRow ? (e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); click(); } }) : undefined}>
        {expandable && (
          <td className="u227-xc">
            {canX && (
              <button type="button" className="u227-xb" aria-expanded={isOpen} aria-controls={isOpen ? detailId : undefined}
                aria-label={isOpen ? 'Collapse row' : 'Expand row'}
                onClick={e => { e.stopPropagation(); toggleExpand(k); }}
                onKeyDown={e => e.stopPropagation()}>
                <Chevron />
              </button>
            )}
          </td>
        )}
        {columns.map((c, j) => (
          <td key={c.key} className={cx(alignOf(c) === 'right' && 'right', c.numeric && 'num', j === 0 && stickyFirstColumn && 'u227-c1', c.className)}>
            {c.render ? c.render(r, i) : (r?.[c.key] ?? '—')}
          </td>
        ))}
      </tr>,
    ];
    if (isOpen) {
      out.push(
        <tr key={`${k}::x`} data-k={`${k}::x`} className="u227-exp" id={detailId}>
          <td colSpan={colCount}><div className="u227-expin">{renderExpanded(r)}</div></td>
        </tr>,
      );
    }
    return out;
  };
  let rowIndex = 0;
  return (
    <div className="u227-wrap" style={maxHeight ? { maxHeight } : undefined}>
      <table className={cx('table ux u227', dense && 'is-dense', stickyFirstColumn && 'is-sticky1', expandable && 'has-expand', className)} aria-label={ariaLabel} aria-busy={loading || undefined}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {expandable && <th scope="col" className="u227-xc"><span className="sr-only">Details</span></th>}
            {columns.map((c, j) => {
              // A column with no data field and no sortValue (e.g. actions) is not sortable unless asked.
              const hasData = c.sortValue || !dataRows.length || dataRows.some(r => r && r[c.key] !== undefined);
              const can = sortable && (c.sortable === true || (c.sortable !== false && hasData));
              const active = sort && sort.key === c.key;
              return (
                <th key={c.key} scope="col" style={colStyle(c)} title={c.headerTitle}
                  className={cx(alignOf(c) === 'right' && 'right', c.numeric && 'num', j === 0 && stickyFirstColumn && 'u227-c1', c.headerClassName)}
                  aria-sort={can ? (active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}>
                  {can ? <button type="button" className="u227-th" onClick={() => setSort(c.key)}><span>{c.label}</span><Arrow /></button> : c.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody ref={bodyRef}>
          {loading ? Array.from({ length: skeletonRows }, (_, i) => (
            <tr key={`sk${i}`} className="is-skel" aria-hidden="true">
              {expandable && <td className="u227-xc" />}
              {columns.map((c, j) => <td key={c.key} className={cx(alignOf(c) === 'right' && 'right', j === 0 && stickyFirstColumn && 'u227-c1')}>
                <Skeleton inline height={10} width={j === 0 ? '70%' : c.numeric ? 56 : '50%'} />
              </td>)}
            </tr>
          )) : sorted.length === 0 ? (
            <tr className="is-empty"><td className="u227-empty" colSpan={colCount}>{typeof empty === 'string' ? <div className="empty-state">{empty}</div> : empty}</td></tr>
          ) : groups ? groups.flatMap(g => [
            g.label != null ? (
              <tr key={`::${g.key}`} className="u227-grp">
                <th scope="colgroup" colSpan={colCount}><span className="u227-gl">{g.label}</span>{g.meta != null && <span className="u227-gm">{g.meta}</span>}</th>
              </tr>
            ) : null,
            ...g.rows.flatMap(r => renderRow(r, rowIndex++)),
          ]) : sorted.flatMap((r, i) => renderRow(r, i))}
        </tbody>
        {footCells && !loading && (
          <tfoot>
            <tr>
              {expandable && <td className="u227-xc" />}
              {columns.map((c, j) => (
                <td key={c.key} className={cx(alignOf(c) === 'right' && 'right', c.numeric && 'num', j === 0 && stickyFirstColumn && 'u227-c1', c.className)}>{footCells[j] ?? ''}</td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
};

export { DataTable };
