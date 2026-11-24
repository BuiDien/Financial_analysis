// Dev-only component gallery at #/dev/ui (loaded lazily from app.jsx only when import.meta.env.DEV).
// Every component of src/ui, rendered side by side in a light and a dark theme island, with its main
// states. Portaled pieces (toast, dialog, palette, tooltip) are triggered from the buttons.

import React from 'react';
import {
  AreaChart, Badge, Button, Card, ChangeText, Checkbox, CopyButton, DataTable, Dialog, EmptyState, ErrorState,
  Icon, IconButton, JobSteps, Menu, NativeSelect, NumberInput, Panel, Pill, ProgressBar, RadioGroup, SearchInput, Segmented, Select,
  SelectTextField, Skeleton, SkeletonSwap, SkeletonText, Sparkline, SplitButton, StatGrid, StatTile, Switch, Tabs,
  Tag, TextInput, Timeline, Tooltip, askConfirm, askPrompt, openCommandPalette, tabPanelId, toast, useContextMenu,
} from './index.js';
import { formatMoney, formatPct, formatPrice } from '../lib/format.js';
import './gallery.css';

const ROWS = [
  { id: 'FPT', name: 'FPT Corp', price: 128500, chg: 1.25, value: 128500000, weight: 25.7 },
  { id: 'VCB', name: 'Vietcombank', price: 92100, chg: -0.42, value: 184200000, weight: 36.8 },
  { id: 'HPG', name: 'Hoa Phat Group', price: 27400, chg: 0, value: 54800000, weight: 11.0 },
  { id: 'MWG', name: 'Mobile World', price: 61200, chg: 2.8, value: 91800000, weight: 18.3 },
  { id: 'VNM', name: 'Vinamilk', price: 66900, chg: null, value: 40140000, weight: 8.2 },
];
const COLUMNS = [
  { key: 'id', label: 'Ticker', render: r => <span className="ticker">{r.id}</span> },
  { key: 'name', label: 'Name' },
  { key: 'price', label: 'Price', numeric: true, render: r => formatPrice(r.price, 'VND') },
  { key: 'chg', label: 'Chg', numeric: true, render: r => <ChangeText value={r.chg} /> },
  { key: 'value', label: 'Value', numeric: true, render: r => formatMoney(r.value, 'VND', { compact: true }) },
];
const TIMELINE = [
  { id: 1, tag: 'alert', date: '14:05', title: 'FPT crossed 128,000 ₫', body: 'Price above alert triggered at 128,500 ₫.', isNew: true },
  { id: 2, tag: 'news', date: '13:40', meta: 'VnExpress', title: 'VN-Index edges higher as banks rally' },
  { id: 3, tag: 'job', date: '11:02', title: 'OCR finished: BCTC Q3 FPT.pdf', body: '8 pages · 2 tables need review.' },
  { id: 4, tag: 'news', date: 'Nov 23', meta: 'CafeF', title: 'Steel makers expect stronger Q4 demand' },
];

const SERIES = [100, 102, 101, 104, 103, 107, 106, 109, 111, 108, 112, 115, 113, 117, 119, 118, 121, 124, 122, 126];
const GROUPED = [
  { group: 'Banks', meta: '2 positions' },
  { id: 'VCB', name: 'Vietcombank', price: 92100, chg: -0.42, value: 184200000, weight: 36.8, note: 'Bought 2,000 on Mar 4 · avg 88,400 ₫' },
  { id: 'TCB', name: 'Techcombank', price: 23800, chg: 0.85, value: 47600000, weight: 9.5, note: 'DCA monthly since Jan' },
  { group: 'Technology', meta: '1 position' },
  { id: 'FPT', name: 'FPT Corp', price: 128500, chg: 1.25, value: 128500000, weight: 25.7, note: 'Long-term core holding' },
  { group: 'Industrials', meta: '2 positions' },
  { id: 'HPG', name: 'Hoa Phat Group', price: 27400, chg: 0, value: 54800000, weight: 11.0, note: '' },
  { id: 'MWG', name: 'Mobile World', price: 61200, chg: 2.8, value: 91800000, weight: 18.3, note: 'Trimmed 30% in October' },
];
const WIDE_COLUMNS = [
  { key: 'id', label: 'Ticker', minWidth: 80, render: r => <span className="ticker">{r.id}</span> },
  { key: 'name', label: 'Name', minWidth: 160 },
  { key: 'price', label: 'Price', numeric: true, minWidth: 110, render: r => formatPrice(r.price, 'VND') },
  { key: 'chg', label: 'Chg', numeric: true, minWidth: 80, render: r => <ChangeText value={r.chg} /> },
  { key: 'value', label: 'Value', numeric: true, minWidth: 120, render: r => formatMoney(r.value, 'VND', { compact: true }) },
  { key: 'weight', label: 'Weight', numeric: true, minWidth: 90, render: r => formatPct(r.weight, { sign: false, decimals: 1 }) },
];
const galUndo = { n: 0 };
const MENU_ITEMS = (onPick) => [
  { type: 'label', label: 'Position' },
  { id: 'open', label: 'Open company', icon: 'eye', kbd: '↵', onSelect: onPick },
  { id: 'chart', label: 'Open chart', icon: 'chart', onSelect: onPick },
  { id: 'refresh', label: 'Refresh quote', icon: 'refresh', kbd: 'R', onSelect: onPick },
  { id: 'alert', label: 'Add alert…', icon: 'bell', disabled: true },
  { type: 'separator' },
  { id: 'remove', label: 'Remove from watchlist', icon: 'close', danger: true, onSelect: onPick },
];

const Section = ({ title, note, children }) => (
  <section className="gal-sec">
    <h3 className="gal-h">{title}</h3>
    {note && <p className="gal-note">{note}</p>}
    <div className="gal-body">{children}</div>
  </section>
);

const Island = ({ theme }) => {
  const [seg, setSeg] = React.useState('1M');
  const [tab, setTab] = React.useState('overview');
  const [sel, setSel] = React.useState('VND');
  const [txt, setTxt] = React.useState('');
  const [num, setNum] = React.useState(1500000);
  const [q, setQ] = React.useState('');
  const [chk, setChk] = React.useState(true);
  const [sw, setSw] = React.useState(false);
  const [radio, setRadio] = React.useState('daily');
  const [mode, setMode] = React.useState('full');
  const [val, setVal] = React.useState(500000000);
  const [loading, setLoading] = React.useState(true);
  const [progress, setProgress] = React.useState(42);
  const [cond, setCond] = React.useState('above');
  const [ccy, setCcy] = React.useState('VND');
  const [qty, setQty] = React.useState(1000);
  const [side, setSide] = React.useState('buy');
  const [segNone, setSegNone] = React.useState(null);
  const [tab2, setTab2] = React.useState('a');
  return (
    <div className="gal-island" data-theme={theme}>
      <div className="gal-theme">{theme === 'dark' ? 'Dark' : 'Light'}</div>

      <Section title="Button / IconButton / CopyButton / SplitButton">
        <div className="gal-row">
          <Button variant="primary" icon="plus">Primary</Button>
          <Button>Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="accent">Accent</Button>
          <Button loading>Saving</Button>
          <Button disabled>Disabled</Button>
        </div>
        <div className="gal-row">
          <Button size="sm" variant="primary">Small</Button>
          <Button size="sm" icon="download">Export</Button>
          <IconButton icon="bell" label="Alerts" />
          <IconButton icon="sparkle" label="AI assistant" active />
          <IconButton icon="close" label="Close" size="sm" variant="ghost" />
          <CopyButton text="VN:FPT" label="Copy ticker" />
          <CopyButton text="VN:FPT" label="Copy ticker" size="sm" />
        </div>
        <div className="gal-row">
          <SplitButton value={mode} onChange={setMode}
            options={[
              { value: 'full', label: 'Run backtest', description: 'Whole history', busyLabel: 'Running…', doneLabel: 'Finished', icon: 'trending' },
              { value: 'ytd', label: 'Run YTD', description: 'Since Jan 1', busyLabel: 'Running YTD…', icon: 'chart' },
              { value: 'dry', label: 'Dry run', description: 'No trades saved', icon: 'eye' },
            ]}
            onRun={() => new Promise(r => setTimeout(r, 1600))} />
          <SplitButton size="sm" value="a" options={[{ value: 'a', label: 'Refresh' }, { value: 'b', label: 'Refresh all' }]} onRun={() => {}} />
        </div>
      </Section>

      <Section title="Tabs / Segmented">
        <Tabs ariaLabel="Company" value={tab} onChange={setTab}
          tabs={[{ value: 'overview', label: 'Overview' }, { value: 'statements', label: 'Statements', badge: 3 }, { value: 'notes', label: 'Notes' }]}
          renderPanel={v => <p className="gal-note">Panel: {v}</p>} />
        <div className="gal-row">
          <Tabs size="sm" ariaLabel="Range" value={seg} onChange={setSeg} tabs={['1D', '1M', '1Y', 'All']} />
          <Segmented value={seg} onChange={setSeg} options={['1D', '1M', '1Y', 'All']} ariaLabel="Range" />
          <Segmented size="sm" value={seg} onChange={setSeg} options={['1D', '1M', '1Y', 'All']} ariaLabel="Range small" />
        </div>
      </Section>

      <Section title="SearchInput / TextInput / NumberInput / Select">
        <div className="gal-grid2">
          <SearchInput value={q} onChange={setQ} placeholder="Search tickers" shortcut
            suggestions={ROWS.map(r => ({ value: r.id, label: r.id, meta: r.name, icon: 'VN' }))}
            onSelect={d => { setQ(d.label); toast(`Picked ${d.label}`); }} />
          <SearchInput size="sm" value={q} onChange={setQ} placeholder="Filter (plain)" />
          <TextInput label="Name" value={txt} onChange={setTxt} placeholder="e.g. Banks" hint="Shown in the sidebar" />
          <TextInput label="Email" value="not-an-email" onChange={() => {}} error="That doesn’t look like an email" />
          <TextInput label="Verified" value="FPT" onChange={() => {}} success="Ticker found" size="sm" />
          <NumberInput label="Amount" value={num} onChange={setNum} min={0} step={100000} suffix="₫" />
          <Select label="Currency" value={sel} onChange={setSel} options={[{ value: 'VND', label: 'VND', hint: 'Vietnamese đồng' }, { value: 'USD', label: 'USD', hint: 'US dollar' }]} />
          <Select size="sm" label="Currency (sm)" value={sel} onChange={setSel} options={['VND', 'USD', 'EUR'].map(v => ({ value: v, label: v }))} />
          <SelectTextField size="sm" label="Select-shaped text field" value={txt} onChange={setTxt} placeholder="Type…" />
        </div>
      </Section>

      <Section title="Checkbox / Radio / Switch">
        <div className="gal-row">
          <Checkbox checked={chk} onChange={setChk} label="Include ETFs" />
          <Checkbox checked={false} indeterminate onChange={() => {}} label="Some selected" />
          <Checkbox checked onChange={() => {}} label="Disabled" disabled />
          <RadioGroup ariaLabel="Frequency" value={radio} onChange={setRadio} options={[{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }]} />
          <Switch checked={sw} onChange={setSw} label="Auto-refresh" />
        </div>
      </Section>

      <Section title="Card / Panel / Badge / Tag">
        <Card title="Holdings" subtitle="2 positions" actions={<><Button size="sm" icon="download">Export</Button><IconButton size="sm" icon="settings" label="Settings" /></>}>
          <Panel title="Panel">A flat sunken box for grouping.</Panel>
        </Card>
        <div className="gal-row">
          {['neutral', 'pos', 'neg', 'warn', 'info', 'accent'].map(t => <Badge key={t} tone={t}>{t}</Badge>)}
          <Badge tone="pos" dot sans>Verified live</Badge>
          <Pill value={1.25} /><Pill value={-0.4} /><ChangeText value={2.1} />
          <Tag>VN30</Tag><Tag onRemove={() => toast('Removed')}>Banks</Tag>
          <Sparkline data={[3, 5, 4, 6, 7, 6, 8]} />
        </div>
      </Section>

      <Section title="StatTile (rolling digits)">
        <StatGrid>
          <StatTile label="Portfolio value" value={val} format={v => formatMoney(v, 'VND')} delta={0.3} deltaLabel="today" live />
          <StatTile label="Total gain" value={40000000} format={v => formatMoney(v, 'VND', { compact: true })} delta={8.7} deltaLabel="all time" spark={[3, 4, 3.6, 5, 5.4, 6.1, 6.6]} />
          <StatTile label="Day change" value={-1250000} format={v => formatMoney(v, 'VND', { sign: true })} delta={-0.4} />
          <StatTile label="Win rate" value={58.3} format={v => formatPct(v, { sign: false, decimals: 1 })} />
        </StatGrid>
        <div className="gal-row"><Button size="sm" onClick={() => setVal(v => v + 1234567)}>Bump value</Button></div>
      </Section>

      <Section title="DataTable" note="Sortable (click a header), numeric right-aligned mono, row click; loading + empty states below.">
        <Card flush title="Watchlist"><DataTable ariaLabel="Watchlist" columns={COLUMNS} rows={ROWS} defaultSort={{ key: 'value', dir: 'desc' }} onRowClick={r => toast(`Open ${r.id}`)} /></Card>
        <div className="gal-grid2">
          <Card flush title="Loading"><DataTable columns={COLUMNS.slice(0, 3)} rows={[]} loading skeletonRows={3} dense /></Card>
          <Card flush title="Empty"><DataTable columns={COLUMNS.slice(0, 3)} rows={[]} empty="No holdings yet" /></Card>
        </div>
      </Section>

      <Section title="Toast / Dialog / Tooltip / CommandPalette" note="Portaled to the page (follow the app theme).">
        <div className="gal-row">
          <Button size="sm" onClick={() => toast('Saved', { type: 'success' })}>Toast success</Button>
          <Button size="sm" onClick={() => toast('Could not reach the backend', { type: 'error' })}>Toast error</Button>
          <Button size="sm" onClick={() => toast('Watchlist deleted', { action: { label: 'Undo', onClick: () => toast('Restored', { type: 'success' }) } })}>Toast + action</Button>
          <Button size="sm" onClick={async () => toast(String(await askConfirm({ title: 'Delete watchlist', message: 'Delete "Banks"? This can’t be undone.', confirmText: 'Delete', danger: true })))}>askConfirm</Button>
          <Button size="sm" onClick={async () => toast(String(await askPrompt({ title: 'New watchlist', label: 'Name', placeholder: 'e.g. Banks', confirmText: 'Create' })))}>askPrompt</Button>
          <DialogDemo />
          <FailingDialogDemo />
          <Tooltip label="Refresh quotes" kbd="R"><Button size="sm">Hover me</Button></Tooltip>
          <Button size="sm" onClick={openCommandPalette}>Open palette</Button>
        </div>
      </Section>

      <Section title="EmptyState / ErrorState / Skeleton">
        <div className="gal-grid2">
          <Card title="Empty"><EmptyState size="sm" title="No watchlists yet" description="Create one to track tickers." action={{ label: 'New watchlist', onClick: () => toast('Create') }} /></Card>
          <Card title="Error"><ErrorState size="sm" title="Couldn’t load quotes" message="The backend isn’t responding." detail={'GET /api/quote/VN:FPT\n503 Service Unavailable'}
            onRetry={() => new Promise((_, rej) => setTimeout(() => rej(new Error('x')), 900))} autoRetry={8} /></Card>
          <Card title="Plain empty"><EmptyState plain title="Nothing here" description="Quiet text-only variant." /></Card>
          <Card title="Skeleton" actions={<Button size="sm" onClick={() => setLoading(l => !l)}>{loading ? 'Load' : 'Reset'}</Button>}>
            <SkeletonSwap loading={loading} skeleton={<div className="gal-stack"><Skeleton width="40%" height={14} /><SkeletonText lines={3} /></div>}>
              <h4 className="gal-sk-title">VN-Index edges higher</h4>
              <p className="gal-note">Banks led the gains; foreign investors were net buyers for a third day.</p>
            </SkeletonSwap>
          </Card>
        </div>
      </Section>

      <Section title="ProgressBar / JobSteps">
        <div className="gal-grid2">
          <div className="gal-stack">
            <ProgressBar title="OCR · BCTC Q3 FPT.pdf" subtitle="job #7" status="running" value={progress} label="Page 3/8"
              log={[{ text: 'Queued', done: true, time: '00:01' }, { text: 'Rendering pages', done: true, time: '00:04' }, { text: 'Reading page 3…', time: '00:09' }]} card />
            <ProgressBar status="queued" label="Waiting for a worker" />
            <ProgressBar status="done" value={100} label="Imported" size="sm" />
            <ProgressBar status="failed" value={60} label="bad csv" size="sm" />
            <div className="gal-row"><Button size="sm" onClick={() => setProgress(p => (p >= 100 ? 0 : p + 20))}>Advance</Button></div>
          </div>
          <JobSteps startedAt={new Date(Date.now() - 12000).toISOString()} onRerun={() => toast('Rerun')}
            steps={[{ label: 'Download statements', status: 'done', meta: '3 files' }, { label: 'OCR pages', status: 'done', meta: '8 pages' }, { label: 'Parse tables', status: 'run' }, { label: 'Reconcile', status: 'wait' }]} />
        </div>
      </Section>


      <Section title="B3g additions · form row alignment" note="Select size=&quot;field&quot;, TextInput, NumberInput and NativeSelect md share one 36px row; a disabled option is skipped by the keyboard.">
        <div className="gal-form-row" data-gal="form-row">
          <TextInput label="Ticker" value={txt} onChange={setTxt} placeholder="e.g. FPT" />
          <Select size="field" label="Condition" value={cond} onChange={setCond}
            options={[{ value: 'above', label: 'Price above' }, { value: 'below', label: 'Price below' }, { value: 'rsi', label: 'RSI below (soon)', disabled: true }, { value: 'move', label: 'Daily move' }]} />
          <NumberInput label="Value" value={num} onChange={setNum} min={0} step={100} suffix="₫" wheel />
          <NativeSelect label="Currency" value={ccy} onChange={setCcy} options={['VND', 'USD', { value: 'EUR', label: 'EUR (soon)', disabled: true }]} />
        </div>
        <div className="gal-row" data-gal="compact-row">
          <NumberInput size="compact" ariaLabel="Quantity" value={qty} onChange={setQty} min={0} step={100} wheel />
          <TextInput size="compact" ariaLabel="Note" value={txt} onChange={setTxt} placeholder="note" />
          <NativeSelect size="compact" ariaLabel="Side" value={side} onChange={setSide} options={[{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }]} />
          <span className="gal-note">compact (26px) · wheel steps the focused number</span>
        </div>
      </Section>

      <Section title="B3g additions · Segmented with no selection / Tabs controlsPanel / icons">
        <div className="gal-row">
          <Segmented ariaLabel="Period (none)" value={segNone} onChange={setSegNone} options={['1M', '3M', '1Y', 'Custom']} size="sm" />
          <Button size="sm" variant="ghost" onClick={() => setSegNone(null)}>Clear</Button>
          <Button size="sm" icon="refresh">Refresh</Button>
          <IconButton icon="refresh" label="Refresh quotes" />
          <Icon name="refresh" size={16} />
        </div>
        <Tabs ariaLabel="Own panel" size="sm" value={tab2} onChange={setTab2} idBase={`gal-${theme}-t2`} controlsPanel
          tabs={[{ value: 'a', label: 'Summary' }, { value: 'b', label: 'Detail' }]} />
        <p className="gal-note" id={tabPanelId(`gal-${theme}-t2`, tab2)} role="tabpanel">Own panel: {tab2}</p>
      </Section>

      <Section title="B3g additions · DataTable" note="minWidth columns, sticky first column, expandable rows, group headers, totals footer, row titles. Scroll the table sideways at 375px.">
        <Card flush title="Holdings by sector">
          <DataTable ariaLabel={`Holdings by sector ${theme}`} columns={WIDE_COLUMNS} rows={GROUPED} stickyFirstColumn maxHeight={300}
            rowTitle={r => `${r.name} · ${formatPct(r.weight, { sign: false, decimals: 1 })} of the portfolio`}
            renderExpanded={r => <span className="gal-note">{r.note}</span>} canExpand={r => !!r.note} expandOnRowClick
            footer={{ id: 'Total', value: formatMoney(507040000, 'VND', { compact: true }), weight: '100.0%' }} />
        </Card>
      </Section>

      <Section title="B3g additions · ProgressBar / JobSteps / EmptyState sm">
        <div className="gal-grid2">
          <div className="gal-stack">
            <div className="gal-row"><span className="gal-note">inline</span><ProgressBar size="sm" value={progress} width={120} hideMeta ariaLabel="Inline progress" /></div>
            <ProgressBar value={progress} label="Label stays, % hidden" hideMeta />
            <Card title="Plain sm"><EmptyState plain size="sm" title="No orders" description="Orders appear after the first import." /></Card>
          </div>
          <JobSteps wrap bare steps={[
            { label: 'Download the monthly statements from the SSI mailbox and match them to accounts', status: 'done', meta: '3 files' },
            { label: 'OCR every page', status: 'done', meta: '8 pages' },
            { label: 'Parse the balance sheet, income statement and cash-flow tables into line items', status: 'run' },
            { label: 'Reconcile', status: 'wait' },
          ]} />
        </div>
      </Section>

      <Section title="B3g additions · Dialog sizes / Menu / Toast dedupe / AreaChart">
        <div className="gal-row">
          {['sm', 'xl', 'full'].map(sz => <SizedDialogDemo key={sz} size={sz} />)}
          <MenuDemo />
          <Button size="sm" onClick={() => toast('Quotes refreshed', { type: 'success' })}>Toast (repeat me)</Button>
          <Button size="sm" onClick={() => { galUndo.n += 1; const n = galUndo.n; toast('Row deleted', { action: { label: 'Undo', onClick: () => toast(`Restored #${n}`, 'success') } }); }}>Toast + own Undo</Button>
        </div>
        <div className="gal-area" data-gal="area"><AreaChart data={SERIES} width={760} height={220} padding={{ t: 16, r: 50, b: 16, l: 0 }} /></div>
      </Section>

      <Section title="Timeline">
        <Timeline items={TIMELINE} filters={[{ value: 'alert', label: 'Alerts' }, { value: 'news', label: 'News' }, { value: 'job', label: 'Jobs' }]} maxHeight={260} />
      </Section>
    </div>
  );
};

const DialogDemo = () => {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Dialog</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Add alert" description="Notify me when the price crosses a level." icon="info"
        onConfirm={() => { setOpen(false); toast('Alert added', { type: 'success' }); }} confirmText="Add alert">
        <NumberInput label="Price" value={130000} onChange={() => {}} suffix="₫" />
      </Dialog>
    </>
  );
};

// A dialog whose save fails: the error toast must stay visible, clickable and announced while the
// modal lock makes #root inert (ToastHost is portaled to <body>).
const FailingDialogDemo = () => {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const save = () => {
    setBusy(true);
    setTimeout(() => { setBusy(false); toast('Save failed: backend unreachable', 'error'); }, 300);
  };
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Dialog (failing save)</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Rename strategy" onConfirm={save} confirmText="Save" busy={busy}>
        <TextInput label="Name" value="Value screen" onChange={() => {}} />
      </Dialog>
    </>
  );
};

const SizedDialogDemo = ({ size }) => {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Dialog {size}</Button>
      <Dialog open={open} onClose={() => setOpen(false)} size={size} title={`Dialog · size="${size}"`} flushBody={size !== 'sm'}
        description="Custom actions are real Buttons with their variants."
        actions={<>
          <span className="gal-note gal-push">3 rows selected</span>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="danger" icon="close">Remove</Button>
          <Button variant="primary" onClick={() => setOpen(false)}>Save</Button>
        </>}>
        {size === 'sm' ? <TextInput label="Name" value="Banks" onChange={() => {}} /> : (
          <DataTable ariaLabel={`Dialog table ${size}`} columns={COLUMNS} rows={[...ROWS, ...ROWS.map(r => ({ ...r, id: r.id + '2' })), ...ROWS.map(r => ({ ...r, id: r.id + '3' }))]} dense />
        )}
      </Dialog>
    </>
  );
};

const MenuDemo = () => {
  const ctx = useContextMenu();
  const btn = React.useRef(null);
  const [open, setOpen] = React.useState(false);
  const pick = (it) => toast(`Menu: ${it.label}`);
  return (
    <>
      <div className="gal-ctx" tabIndex={0} role="button" aria-label="Right-click target (or press Shift+F10)" onContextMenu={ctx.onContextMenu('FPT')}
        onKeyDown={e => { if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); ctx.openAt(r.left + 24, r.bottom - 6, 'FPT'); } }}>
        Right-click me
      </div>
      <Menu {...ctx.menuProps} items={MENU_ITEMS(pick)} ariaLabel="FPT actions" />
      <IconButton ref={btn} icon="settings" label="More actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)} />
      <Menu open={open} onClose={() => setOpen(false)} anchor={btn} align="end" items={MENU_ITEMS(pick)} ariaLabel="More actions" />
    </>
  );
};

const Gallery = () => (
  <div className="page gal">
    <div className="page-header">
      <div>
        <h1 className="page-title">Component gallery</h1>
        <p className="page-sub">src/ui · dev only · every component in a light and a dark island. Catalogue: src/ui/README.md</p>
      </div>
    </div>
    <div className="gal-cols">
      <Island theme="light" />
      <Island theme="dark" />
    </div>
  </div>
);

export default Gallery;
