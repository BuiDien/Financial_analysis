// Statements table: one row per line item (Vietnamese name, Mã số when the catalogue has
// one), one column per period. The line-item column is sticky and the table scrolls
// sideways inside its card, so the page never scrolls horizontally on a phone.

import React from 'react';
import { Button, Card, DataTable } from '../../ui';
import { hxTy } from './statements-format.js';

const StatementsTable = ({ series, xs, fmtX, codeOf, onOpenPoint, onCopy }) => {
  const hasCodes = series.some(s => codeOf(s.key));
  const columns = React.useMemo(() => [
    {
      key: 'name', label: 'Line item', className: 'co-st-sticky co-st-name', headerClassName: 'co-st-sticky',
      render: (s) => (
        <span className="co-st-line">
          <i className="co-st-swatch" style={{ background: s.color }} aria-hidden="true" />
          <span>{s.name}</span>
        </span>
      ),
    },
    ...(hasCodes ? [{ key: 'code', label: 'Mã số', className: 'num co-st-code', render: (s) => codeOf(s.key) || '—' }] : []),
    ...xs.map(x => ({
      key: x, label: fmtX(x), numeric: true,
      render: (s) => {
        const q = s.points.find(p => p.x === x);
        if (!q) return <span className="co-st-blank" aria-label="no value">·</span>;
        if (q.status === 'conflict') {
          return <Button size="sm" variant="ghost" className="co-st-conflict" onClick={() => onOpenPoint(s, q)}>⚠ sources differ</Button>;
        }
        return (
          <button type="button" className="co-st-cell" onClick={() => onOpenPoint(s, q)} title="Show source">
            {hxTy(q.y)}{q.origin === 'calculated' && <sup className="co-st-calc" title="calculated">c</sup>}
          </button>
        );
      },
    })),
  ], [series, xs, fmtX, hasCodes, codeOf, onOpenPoint]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card id="hx-table" className="co-st-card" title="Statement table" subtitle="tỷ đồng · c = calculated · click a value for its source"
      actions={<Button size="sm" onClick={onCopy}>Copy</Button>} flush>
      <DataTable ariaLabel="Statement values by period" className="co-st-table" dense sortable={false}
        rows={series} rowKey="key" columns={columns} />
    </Card>
  );
};

export { StatementsTable };
