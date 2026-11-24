# src/ui: Helix component library

Every page builds its UI from this folder. The interactive pieces are ports of
[Lucian UX/UI Prompt](https://lucianlabs.dev/uxui-prompt/) elements (MIT; each file keeps its
`Lucian UX/UI Prompt #ID · MIT License …` line). The basics with no Lucian match (Button, Card,
Badge, table base) are built from the same tokens.

```js
import { Button, Card, DataTable, toast } from './ui';          // from src/
import { Button } from '../ui';                                 // from src/<folder>/
import { formatMoney, formatPct, formatPrice } from './lib/format.js';
```

Dev gallery: run `npm run dev` and open `http://127.0.0.1:5500/#/dev/ui`. It renders every
component in a light and a dark island. The route exists only on the dev server
(`import.meta.env.DEV`), and the production build does not include it.

## Rules for page authors

1. **Use the components, not `div` + `style={{…}}`.** A boxed section is a `<Card>`, a grouped
   sub-box is a `<Panel>`, a status chip is a `<Badge>`, and a list of rows is a `<DataTable>`.
   Use inline `style` only for values computed at runtime (a width from data, a colour from a
   series). Everything else goes in a class.
2. **Format numbers with `src/lib/format.js`.** Do not use `toLocaleString`, `Intl.NumberFormat` or
   `toFixed` in pages.
   - `formatMoney(500000000, 'VND')` gives `500,000,000 ₫`. VND never has decimals, and the `₫` goes after the number.
   - `formatMoney(1.5e9, 'VND', { compact: true })` gives `1.5B ₫`, and `formatMoney(1234.5, 'USD')` gives `$1,234.50`.
   - `formatPrice(53600, 'VND')` gives `53,600 ₫`, and `formatPrice(186.64, 'USD')` gives `186.64 USD`. This is the listing's own currency, with no FX.
   - `formatPct(1.234)` gives `+1.23%` (pass `{ sign: false }` to drop the `+`). `formatNumber(n, decimals)` and `formatCompact(n)` give `3.49T` / `21.30M`.
   - A missing value always formats as `—`.
   - Dates: `formatDateTime(v)` gives `Nov 24, 2026, 14:05` (`{ year: false }` drops the year, `{ naiveUtc: true }` reads a zone-less backend timestamp as UTC) and `formatDate(v)` gives `Nov 24, 2026`. `toDate(v)` parses epoch seconds/ms or ISO strings.
   - Statements keep their Vietnamese *tỷ* helpers (`hxTy`). That is a deliberate exception.
   - `formatMoney(v, 'VND', { decimals: 2 })` is an explicit escape hatch. Do not use it for normal display.
   - Rounding is half away from zero and identical in every formatter. A value that rounds to zero never shows a sign (`-0` becomes `0`). Compact output steps up a unit instead of printing `1000K`.
3. **Use toasts and dialogs from here.** That means `toast(msg, { type })`,
   `await askConfirm({…})` and `await askPrompt({…})`. Never call `window.confirm` or `prompt`.
4. **Class naming.**
   - Lucian ports keep their scoped prefix (`.u046-…`) under a `.ux` root.
   - Token-built parts use short owned names (`.btn`, `.icon-btn`, `.card*`, `.panel`, `.pill*`, `.tag`, `.table`, `.stat*`, `.empty-state`).
   - Page-specific CSS uses a page prefix (`.pf-…` for portfolio, `.scan-…` for scan, and so on) and must not restyle `.u*` internals.
   - Never add global element selectors.
5. **Themes, motion and access.**
   - Colours come from tokens (`--text`, `--accent`, `--pos`, … or the `--ux-*` aliases). Never hard-code hex values that ignore dark mode.
   - Every component honours `prefers-reduced-motion`.
   - Keep `aria-*` labels: `IconButton` needs `label`, `Tabs` / `RadioGroup` / `DataTable` take `ariaLabel`.
6. **Hosts are mounted once** in `app.jsx`: `<ToastHost/> <DialogHost/> <TooltipHost/> <CommandPalette/>`.
   Do not mount them again in a page.
7. **Legacy modules were removed in v2.** Import components from `./ui` and formatters from
   `./lib/format.js`.
8. **Responsive layout.**
   - The shell already handles ≤ 760 px: the sidebar becomes a rail, the ticker tape is hidden, and pages get a 16 px gutter.
   - Page grids must collapse themselves, for example `grid-template-columns: repeat(auto-fit, minmax(…, 1fr))`.

---

## Catalogue

### Button: tokens
`import { Button } from './ui'`

| prop | |
|---|---|
| `variant` | `primary` (ink) · `secondary` (default) · `ghost` · `danger` · `accent` |
| `size` | `md` (default) · `sm` |
| `loading` | spinner, disabled, `aria-busy` |
| `icon` / `iconRight` | Icon name (`'plus'`) or a node |
| `block` | full width |
| …rest | passed to `<button>` (`onClick`, `disabled`, `type`, `title`) |

```jsx
<Button variant="primary" icon="plus" onClick={add}>Add transaction</Button>
<Button size="sm" loading={saving}>Save</Button>
```

### IconButton: tokens
`<IconButton icon="bell" label="Alerts" size="sm|md" variant="default|ghost" active? kbd? />`.
`label` is required. It becomes `aria-label` and the tooltip. When `active` is set, the button gets
`aria-pressed` and the accent look.

### CopyButton: #008
`<CopyButton text="VN:FPT" label="Copy ticker" size="sm|md" onCopied? />`. `text` can be a
function. The icon morphs into a check and a "Copied" bubble appears.

### SplitButton: #010
```jsx
<SplitButton value={mode} onChange={setMode} onRun={(m) => api.runBacktest(m)}
  options={[{ value: 'full', label: 'Run backtest', description: 'Whole history', icon: 'trending',
              busyLabel: 'Running…', doneLabel: 'Finished' }]} size="sm|md" align="right|left" busy? />
```
If `onRun` returns a Promise, the button stays busy until it settles, shows "done" for 1.8 s on
success, and goes back to idle on failure. Pass `busy` to drive the state from a job.

### Tabs: #416
```jsx
<Tabs ariaLabel="Company" value={tab} onChange={setTab} size="sm|md" block?
  tabs={[{ value: 'overview', label: 'Overview' }, { value: 'notes', label: 'Notes', badge: 3 }]}
  renderPanel?={(v) => <Panel …/>} />
```
Keyboard: ←/→ move (wrapping), Home/End jump to the ends. For hash-routed section tabs, keep
`route-tabs.jsx` (real links).
- `aria-controls`: with `renderPanel`, only the active tab points at the (only) rendered panel. Without
  it, no tab carries `aria-controls`. If you render the panel yourself, give it
  `id={tabPanelId(idBase, value)}` and pass `idBase` + `controlsPanel`.

### Segmented: #047
`<Segmented value onChange options={['1D','1M','1Y']|[{value,label}]} ariaLabel size="sm|md" />`

`value={null}` means no selection: nothing is checked and the knob is hidden. The first option is the
Tab stop. Space/Enter checks the focused option, → checks the first option and ← checks the last; after
that, ←/→ move as usual. A value that matches no option
still shows the first option, as before.

### SearchInput: #429
```jsx
<SearchInput value={q} onChange={setQ} placeholder="Search tickers" shortcut? size="sm|md"
  suggestions?={[{ value, label, meta?, icon? }] | (query) => items} onSelect?={(item) => …}
  onSubmit?={(text) => …} />
```
Without `suggestions` it is a plain search field with a clear button.

### TextInput / NumberInput: #434
```jsx
<TextInput label="Name" value={v} onChange={setV} hint="Shown in the sidebar" error?="…" success?="…"
  prefix? suffix? size="sm|md" />
<NumberInput label="Amount" value={n} onChange={setN} min={0} step={100000} decimals? suffix="₫" wheel? />
<NativeSelect label="Side" value={side} onChange={setSide} options={[{ value: 'buy', label: 'Buy' }, 'sell']} placeholder? />
```
- `size="compact"` (26px) suits table cells and dense toolbars. It works on TextInput, NumberInput and NativeSelect.
- `ariaLabel` names the field when there is no visible `label`. It works on TextInput, NumberInput and NativeSelect.
- `wheel` lets the mouse wheel step a NumberInput by `step` (Shift steps ×10), but only while the field has focus. A field the pointer merely passes over never takes the page scroll.
- `NativeSelect` is a real `<select>` in the same #434 shell (same height, ring, label and hint row).
  Use it for dense forms and cells where the OS picker is better. `onChange` gets the option's
  original value, so a number stays a number. Options may be `disabled`.
`error` and `success` take `true` (ring only) or a message. NumberInput accepts typed commas, ↑/↓
step the value (Shift steps ×10), and an out-of-range value shows the error ring. `onChange` still
reports out-of-range values, so validate against `min`/`max` before saving. Your own `onFocus`,
`onBlur` and `onKeyDown` run alongside the built-in ones.

### Select: #031
`<Select label value onChange options={[{ value, label, hint?, badge?, color?, disabled? }]} size="sm|md|field" disabled? />`.
`SelectTextField` is a text field in the same shape, for forms that mix both.
- `size="md"` is the element's own 56px field. `sm` is 36px.
- `size="field"` is 36px in TextInput's look (surface, hairline ring, 11.5px label). It lines up with
  `TextInput` / `NumberInput` md in one form row, so use it in forms that mix them. md keeps 56px,
  because existing screens (Company history filters, OCR inbox) are laid out around it.
- A `disabled` option is dimmed, can't be clicked, and is skipped by ↑/↓, Home/End and type-ahead.

### Checkbox / Switch / RadioGroup: #433
```jsx
<Checkbox checked={c} onChange={setC} label="Include ETFs" indeterminate? />
<Switch checked={s} onChange={setS} label="Auto-refresh" labelPosition="start|end" />
<RadioGroup ariaLabel="Frequency" value={f} onChange={setF} options={[{ value: 'd', label: 'Daily' }]} direction="row|column" />
```

### Card / Panel: tokens
```jsx
<Card title="Holdings" subtitle="2 positions" actions={<Button size="sm">Export</Button>} flush? footer? overflow?>
  …
</Card>
<Panel title="Filters">…</Panel>
```
Use `flush` for a table body with no padding. Use `overflow` when popovers must escape the card.

### StatTile / StatGrid / RollingNumber: #098
```jsx
<StatGrid>
  <StatTile label="Portfolio value" value={total} format={(v) => formatMoney(v, 'VND')}
    delta={dayPct} deltaLabel="today" spark?={series} live? size="sm|md|lg" />
</StatGrid>
```
Digits roll when the value changes. Long values shrink to fit the tile. `value` may also be a
ready-made string.

### DataTable: #227
```jsx
<DataTable ariaLabel="Holdings" rows={rows} rowKey="ticker" onRowClick={open}
  columns={[
    { key: 'ticker', label: 'Ticker', render: (r) => <span className="ticker">{r.ticker}</span> },
    { key: 'value', label: 'Value', numeric: true, render: (r) => formatMoney(r.value, r.currency) },
    { key: 'note', label: 'Note', sortable: false },
  ]}
  defaultSort={{ key: 'value', dir: 'desc' }} dense? maxHeight={420} loading={q.loading}
  empty={<EmptyState size="sm" title="No holdings" />} highlightNew? selectedKey? />
```
- Columns marked `numeric` are right-aligned in mono.
- Sorting compares `sortValue(row)` or `row[key]`, and empty values go last.
- Sorting is controlled through `sort` / `onSortChange`, or uncontrolled.
- The header is sticky inside `maxHeight`.
- Rows glide into place when the sort changes (only for 100 rows or fewer).
- **Keep raw numbers in `row[key]`** and format them in `render`, or pass `sortValue`. Number-like display strings such as `"1,234 ₫"`, `"+1.2%"`, `"−10%"` and `"3.4B"` do sort numerically, but raw values are exact.
- A column with no data field and no `sortValue` (for example an actions column) is not sortable unless you pass `sortable: true`.
- Give every row a unique `rowKey` value. Rows missing it fall back to their position in `rows`.
- `headerClassName` adds a class to a column's `<th>`.
- `minWidth` on a column sets the column's minimum width (px number or CSS length).
- `stickyFirstColumn` pins the first column (and the expand toggle) while the table scrolls sideways.
- `rowTitle={(row) => '…'}` puts a tooltip / accessible description on each row.
- `footer` adds a totals row in `<tfoot>`, sticky at the bottom inside `maxHeight`. Pass
  `{ [columnKey]: node }` or an array in column order.
- `groupBy="sector"` (or `(row) => label`) draws group header rows in first-appearance order. Sorting
  happens inside each group. You can also put marker items in `rows` instead: an object whose only
  keys are `group`, plus optional `meta` and `key`, starts a group.
  `{ group: 'Banks', meta: '2 positions' }` is a marker; `{ group: 'Banks', ticker: 'VCB' }` is a data row.
- `renderExpanded={(row) => node}` adds a leading toggle column with a real button
  (`aria-expanded` / `aria-controls`). It opens a full-width detail row under the row.
  - `canExpand(row)` hides the toggle for some rows.
  - The open set can be uncontrolled (`defaultExpandedKeys`) or controlled (`expandedKeys` + `onExpandedChange(keys)`).
  - `expandOnRowClick` (when there is no `onRowClick`) makes a row click toggle it too. The row then
    becomes focusable (`tabIndex=0`, `aria-expanded`), and Enter/Space toggles it.
  - Open detail rows glide with their parent row when the sort changes.

```jsx
<DataTable ariaLabel="Holdings" columns={cols} rows={rows} rowKey="ticker" groupBy="sector" stickyFirstColumn
  footer={{ ticker: 'Total', value: formatMoney(total, 'VND') }} rowTitle={r => r.name}
  renderExpanded={r => <TickerNotes ticker={r.ticker} />} />
```

### Badge / Tag / Pill / ChangeText / Sparkline: tokens
```jsx
<Badge tone="neutral|pos|neg|warn|info|accent" dot? outline? sans?>Verified</Badge>
<Tag onRemove?={…}>VN30</Tag>
<Pill value={1.2} />   <ChangeText value={-0.4} />   <Sparkline data={[…]} width={80} height={24} />
```

### Toast: #435
```js
toast('Saved', { type: 'success' });                 // success | error | info
toast('Could not save', 'error');                    // string shorthand for { type }
toast('Deleted', { action: { label: 'Undo', onClick: restore }, duration: 6000 });
const id = toast('Uploading…', { duration: 0 }); toast.dismiss(id);
```
- Up to three toasts stack. Hover or focus fans them out and pauses them.
- Swipe a toast or press × or Esc to dismiss it.
- The default duration is 4.5 s.
- A toast with the same message and type as one still on screen does not stack a copy. The visible one
  pulses, its timer and time bar restart, and `toast()` returns its id. Toasts with an action dedupe
  only when both use the same `onClick`, so "Deleted · Undo" for two different items stacks. A
  no-action repeat never joins a toast that has an action. Pass `{ dedupe: false }` to always stack.

### Dialog / askConfirm / askPrompt: #436
```jsx
if (await askConfirm({ title: 'Delete note', message: 'This can’t be undone.', confirmText: 'Delete', danger: true })) …
const name = await askPrompt({ title: 'New watchlist', label: 'Name', placeholder: 'e.g. Banks', value?, confirmText: 'Create', hint? });

<Dialog open={open} onClose={close} title="Add alert" description="…" icon="info|danger|none"
  onConfirm={save} confirmText="Add" tone="default|danger" busy={saving} size="sm|md|lg|xl|full" actions?={…}
  bodyClassName? flushBody?>
  …fields…
</Dialog>
```
- **Sizes:** `sm` is 320 px, `md` (the default) is 400, `lg` is 560 and `xl` is 840. `full` is the
  viewport less a 16 px margin. In `xl` / `full` the title and actions stay put and only the body
  scrolls.
- **`actions`** is your own row of `<Button>`s. They keep their variants and sizes. The row is
  right-aligned and wraps; give a leading non-button item (a total) `margin-right: auto`. Without
  `actions`, the built-in Cancel / confirm pair is unchanged.
- **Content area:** `bodyClassName` styles it. `flushBody` drops its top gap and runs it edge to edge,
  which suits tables and previews.

```jsx
<Dialog open size="xl" flushBody title="Import" onClose={close}
  actions={<><Button onClick={close}>Cancel</Button><Button variant="primary" onClick={commit}>Commit</Button></>}>
  <DataTable … />
</Dialog>
```
Focus is trapped inside the dialog. Esc or a backdrop click cancels, and focus returns to the
opener (unless your code already moved focus elsewhere). A danger dialog focuses Cancel first.
While any modal is open, `#root` is `inert` and `aria-hidden`, page scroll is locked, and the
global keyboard shortcuts (including ⌘K) are paused.

### EmptyState: #440
`<EmptyState title description? action?={{ label, onClick, icon? } | node} size="sm|md" plain? />`.
`plain` is the quiet text-only variant for small spaces. `size="sm"` is the compact form of either variant:
- The illustrated one uses a 112 px folder and smaller type.
- The plain one uses 16 px padding, a 14 px sans title and 12 px text, for table cells and side panels.

### ErrorState: #090
`<ErrorState title message? detail? onRetry?={() => q.refetch()} autoRetry={8} label? size? card? />`.
`onRetry` should return a promise. A rejected retry shakes and sparks, and a resolved one plugs back
in. With `autoRetry`, a countdown ring runs before each automatic try, up to 3 tries.

### Skeleton / SkeletonText / SkeletonSwap: #439
```jsx
<Skeleton width={120} height={14} circle? inline? />
<SkeletonSwap loading={q.loading} skeleton={<SkeletonText lines={4} />}>
  <h4>…</h4><p>…</p>
</SkeletonSwap>
```
The legacy `.skeleton` class uses the same shimmer.

### Tooltip / TooltipHost: #437
Put `data-tip="Refresh"` (and optionally `data-tip-kbd="⌘ R"`) on any element, or wrap a child in
`<Tooltip label kbd>`. A single host serves the whole app.

### ProgressBar: #083
`<ProgressBar value={42|null} status="queued|running|done|failed" title? subtitle? label? meta? log?={[{ text, done?, failed?, time? }]} size="sm|md" card? hideMeta? width? />`.
- A `null` value (or `queued`) shows the indeterminate bar. `normStatus()` maps backend job statuses.
- `hideMeta` drops the right-hand meta text (the default "NN%"). The row stays only if there is a `label`.
- `width` (px or a CSS length) sizes the bar for inline use in a toolbar or table cell.

### JobSteps: #454
`<JobSteps steps={[{ label, status: 'wait'|'run'|'done'|'fail', meta? }]} startedAt? finishedAt? onRerun? bare? wrap? />`

`wrap` lets long labels (and meta) wrap instead of being cut with "…". Each step grows to fit, and the
connector is measured from the first to the last step icon, so it stays joined.

### Timeline: #271
`<Timeline items={[{ id, title, body?, date?, meta?, tag?, href?, isNew? }]} filters?={[{ value, label, color? }]} maxHeight? onItemClick? />`

### CommandPalette: #046
Mounted in `app.jsx` with `nav`, `tickers`, an optional `commands` list
(`[{ id, label, sub?, icon?, kbd?, group?, onRun }]`), `onNavigate` and `onPickTicker`. It opens on
⌘K (the rebindable shortcut), from the header search, or with `openCommandPalette()`.

### SideNav / useSidebarRail: #417
This is the app sidebar (`sidebar.jsx`). `useSidebarRail()` returns `[rail, toggle, forced]`. The
state is persisted, and the rail is forced at ≤ 760 px.

### Menu / useContextMenu: #038
```jsx
<Menu open={open} onClose={() => setOpen(false)} anchor={buttonRef} align="start|end"   // dropdown
  items={[{ id: 'open', label: 'Open', icon: 'eye', kbd: '↵', onSelect }, { type: 'separator' },
          { type: 'label', label: 'Danger zone' }, { id: 'del', label: 'Delete', danger: true, disabled? }]}
  onSelect?={(item) => …} ariaLabel="Row actions" />

const ctx = useContextMenu();                                                            // right-click
<tr onContextMenu={ctx.onContextMenu(row)} />  <Menu {...ctx.menuProps} items={itemsFor(ctx.data)} />
```
- **Placement:** the menu is portaled to `<body>` and placed at `x`/`y` (viewport coordinates) or under
  `anchor`. Near an edge it flips and grows from the matching corner.
- **Keyboard:** ↑/↓ (wrapping, skips disabled items), Home/End, type-ahead, Enter/Space, Esc, Tab.
- **Focus:** it returns to the opener (or `returnFocus`) on close.
- **Closing:** an outside press, a scroll or a resize closes it. A press on the anchor is left to the
  anchor's own toggle.
- **Shortcuts:** the app shortcuts are paused while the menu is open.
- **Esc:** it closes the menu even when focus has left it.
- **Anchor a11y:** the menu has `role="menu"` and `aria-orientation="vertical"`. The trigger is yours:
  give it `aria-haspopup="menu"` and `aria-expanded={open}`.
- For the keyboard, open a right-click menu on Shift+F10 / the ContextMenu key with `ctx.openAt(x, y, data)`.

### Icon
`import { Icon, RefreshIcon } from './ui'`. This is the app icon set plus `refresh`, which is owned in
`ui/Icon.jsx` because `src/icons.jsx` is outside the library. Every `icon="name"` prop in src/ui
resolves through it, so `<Button icon="refresh">` and `<IconButton icon="refresh" label="Refresh">` work.

### AreaChart
`<AreaChart data={series} width={760} height={220} padding={{ t, r, b, l }} color? drawKey? ticks? formatTick? />`

This is the app's area chart, drawn at its box's real pixel size:
- Axis labels keep their 10 px size at 375 px instead of being squashed by a stretched viewBox.
- Gridlines follow the plot height (one per ~44 px, 2–`ticks`).
- Overlapping labels are dropped, and the right gutter fits the widest label.
- It fills its container's height. If the container has no height, it keeps the `width:height` ratio.

### Existing ports
- `Wizard` (#042)
- `TagInput` (#029)
- `SidePanel` (#273)
- `GrowthChart` / `SmallMultiples` (#400, `ui/charts/`)

The `Lx*` names are still exported.

### MarkdownText
`<MarkdownText text variant="news|ai" />` renders light markdown. Only http(s) links are rendered,
and images become links.
