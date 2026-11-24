// Alert condition catalog + helpers shared by the Alerts page and Today's
// triggered-alerts card.
// monitored: evaluated by the app's alert monitor against live quotes. RSI /
// volume alerts need indicator data the monitor doesn't fetch yet, so they
// can't be created; existing ones show as "Not monitored".
// unit 'price' = the listing's own currency (Vietnamese stocks in đồng).

import { formatDateTime, formatNumber, formatPrice } from '../../../lib/format.js';

const ALERT_TYPES = [
  { id: 'price_above', label: 'Price rises above', unit: 'price', icon: 'arrowUp', monitored: true },
  { id: 'price_below', label: 'Price falls below', unit: 'price', icon: 'arrowDown', monitored: true },
  { id: 'pct_move', label: 'Daily move exceeds', unit: '%', icon: 'trending', monitored: true },
  { id: 'rsi_above', label: 'RSI rises above', unit: '', icon: 'chart', monitored: false },
  { id: 'rsi_below', label: 'RSI falls below', unit: '', icon: 'chart', monitored: false },
  { id: 'volume_spike', label: 'Volume spikes above avg', unit: '×', icon: 'trending', monitored: false },
];

const alertType = (id) => ALERT_TYPES.find(x => x.id === id);

const describeAlert = (a) => {
  const t = alertType(a.type);
  if (!t) return a.type;
  const val = t.unit === 'price'
    ? (a.currency ? formatPrice(a.value, a.currency) : formatNumber(a.value, a.value % 1 ? 2 : 0))
    : t.unit === '%' ? `${a.value}%` : t.unit === '×' ? `${a.value}×` : a.value;
  return `${t.label} ${val}`;
};

// 'triggered' | 'unmonitored' | 'active' | 'paused'
const alertStatus = (a) => {
  if (a.triggered) return 'triggered';
  if (!alertType(a.type)?.monitored) return 'unmonitored';
  return a.active ? 'active' : 'paused';
};

const triggeredAtText = (a) => {
  if (!a.triggeredAt) return '';
  const when = formatDateTime(a.triggeredAt, { year: false });
  return a.triggeredPrice != null ? `${when} at ${formatPrice(a.triggeredPrice, a.currency || 'USD')}` : when;
};

export { ALERT_TYPES, alertType, describeAlert, alertStatus, triggeredAtText };
