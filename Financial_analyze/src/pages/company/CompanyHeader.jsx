// Company header: monogram, name (opens the holdings switcher), ticker, live price with the
// change badge, quote status, and the watchlist / statements / alert actions.

import React from 'react';
import { Icon } from '../../icons.jsx';
import { Badge, Button, CopyButton, Pill } from '../../ui';
import { formatMoney } from '../../lib/format.js';
import { cx } from '../../ui/util.js';

const HoldingSwitcher = ({ holdings, portfolioStatus, live, isActive, nameOf, onPick, onClose }) => {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(true); };
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target) && !e.target.closest?.('.co-name-btn')) onClose(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    ref.current?.querySelector('button')?.focus({ preventScroll: true });
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [onClose]);
  const emptyText = !live ? 'Backend offline.' : portfolioStatus === 'error' ? 'Portfolio unavailable right now.'
    : portfolioStatus === 'loading' ? 'Loading portfolio…' : 'No holdings yet.';
  return (
    <div ref={ref} className="co-switcher" role="menu" aria-label="Switch stock">
      <div className="co-switcher-head">Your portfolio · {holdings.length} holdings</div>
      {holdings.length === 0 && <div className="co-switcher-empty">{emptyText}</div>}
      {holdings.map(h => (
        <button key={h.sym} type="button" role="menuitem" className={cx('co-switcher-item', isActive(h.sym) && 'is-active')}
          onClick={() => onPick(h.sym)}>
          <span className="ticker">{h.sym}</span>
          <span className="co-switcher-name">{nameOf(h.sym)}</span>
          <span className="num">{formatMoney(h.price, (h.currency || 'USD').toUpperCase())}</span>
        </button>
      ))}
    </div>
  );
};

const CompanyHeader = ({
  activeAsset, name, holdings, portfolioStatus, live, isActive, nameOf, onPick,
  price, chg, chgAbs, money, statusText, marketOpen, quoteErr,
  inWatchlist, activeListName, onToggleWatch, onFinancials, onAlert,
}) => {
  const [open, setOpen] = React.useState(false);
  const nameBtn = React.useRef(null);
  const close = React.useCallback((refocus) => { setOpen(false); if (refocus) nameBtn.current?.focus(); }, []);
  const bare = String(activeAsset).replace(/^VN:/, '');
  return (
    <header className="page-header co-header">
      <div className="co-id">
        <div className="co-mono" aria-hidden="true">{bare.slice(0, 2)}</div>
        <div className="co-id-text">
          <div className="co-name-row">
            <button ref={nameBtn} type="button" className="co-name-btn" aria-haspopup="menu" aria-expanded={open}
              onClick={() => setOpen(o => !o)} data-tip="Switch stock">
              <h1 className="co-name">{name}</h1>
              <Icon name={open ? 'arrowUp' : 'arrowDown'} size={18} />
            </button>
            <Badge tone="neutral" className="co-ticker">{activeAsset}</Badge>
            <CopyButton text={bare} label={`Copy ${bare}`} size="sm" />
            {open && <HoldingSwitcher holdings={holdings} portfolioStatus={portfolioStatus} live={live}
              isActive={isActive} nameOf={nameOf} onClose={close} onPick={(sym) => { onPick(sym); setOpen(false); }} />}
          </div>
          <div className="co-price-row">
            <span className="num co-price">{money(price)}</span>
            {chg != null && <Pill value={chg} />}
            {chgAbs != null && <span className="num co-chg-abs">{chgAbs >= 0 ? '+' : ''}{money(chgAbs)} today</span>}
          </div>
          <p className={cx('co-status', quoteErr && 'is-warn')}>
            {marketOpen && <span className="live-dot" aria-hidden="true" />}{statusText}
          </p>
        </div>
      </div>
      <div className="co-actions">
        <Button icon={inWatchlist ? 'starFill' : 'star'} onClick={onToggleWatch} aria-pressed={inWatchlist}
          className={cx(inWatchlist && 'co-watch-on')} title={inWatchlist ? 'Remove from active watchlist' : `Add to ${activeListName}`}>
          {inWatchlist ? 'In watchlist' : 'Watchlist'}
        </Button>
        <Button icon="portfolio" onClick={onFinancials}>Financials</Button>
        <Button icon="alerts" onClick={onAlert}>Alert</Button>
      </div>
    </header>
  );
};

export { CompanyHeader };
