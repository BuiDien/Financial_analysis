// Watch-board instrument catalog and the app-wide ticker → backend market map
// (exported as HOME_LIVE_TICKER: the watchlist store, alerts and the company page
// read it so "VCB" is quoted as "VN:VCB"). Instruments the user typed in are
// persisted locally and merged into both maps at load.

const HOME_WATCH_KEY = 'helix_home_watch_v1';
const HOME_CUSTOM_KEY = 'helix_home_custom_v1';

// VN indices are points (no ×1000 scaling). Kept local so this module has no
// import cycle with watchlist-store.jsx (which imports LIVE_TICKER from here).
const VN_INDEX_CODES = new Set(['VNINDEX', 'VN30', 'HNXINDEX', 'HNX30', 'UPCOMINDEX']);

const INSTRUMENTS = {
  // Indices
  SPX: { name: 'S&P 500', cls: 'Index', dp: 2 },
  NDX: { name: 'Nasdaq 100', cls: 'Index', dp: 2 },
  DJI: { name: 'Dow Jones', cls: 'Index', dp: 2 },
  RUT: { name: 'Russell 2000', cls: 'Index', dp: 2 },
  VIX: { name: 'Volatility Index', cls: 'Index', dp: 2 },
  FTSE: { name: 'FTSE 100', cls: 'Index', dp: 2 },
  N225: { name: 'Nikkei 225', cls: 'Index', dp: 2 },
  DAX: { name: 'DAX (Germany)', cls: 'Index', dp: 2 },
  CAC: { name: 'CAC 40 (France)', cls: 'Index', dp: 2 },
  HSI: { name: 'Hang Seng (HK)', cls: 'Index', dp: 2 },
  SSE: { name: 'Shanghai Composite', cls: 'Index', dp: 2 },
  KOSPI: { name: 'KOSPI (Korea)', cls: 'Index', dp: 2 },
  // Vietnam (vnstock/VCI on the backend; stock prices in nghìn đồng)
  VNINDEX: { name: 'VN-Index (HOSE)', cls: 'Vietnam', dp: 2 },
  VN30: { name: 'VN30 Index', cls: 'Vietnam', dp: 2 },
  HNXINDEX: { name: 'HNX-Index', cls: 'Vietnam', dp: 2 },
  UPCOMINDEX: { name: 'UPCoM Index', cls: 'Vietnam', dp: 2 },
  VNM: { name: 'Vinamilk', cls: 'Vietnam', dp: 2 },
  FPT: { name: 'FPT Corp', cls: 'Vietnam', dp: 2 },
  HPG: { name: 'Hòa Phát Group', cls: 'Vietnam', dp: 2 },
  VCB: { name: 'Vietcombank', cls: 'Vietnam', dp: 2 },
  VIC: { name: 'Vingroup', cls: 'Vietnam', dp: 2 },
  MWG: { name: 'Thế Giới Di Động', cls: 'Vietnam', dp: 2 },
  // Commodities
  XAU: { name: 'Gold (spot /oz)', cls: 'Commodity', dp: 2, unit: '$' },
  XAG: { name: 'Silver (spot /oz)', cls: 'Commodity', dp: 2, unit: '$' },
  WTI: { name: 'Crude Oil WTI', cls: 'Commodity', dp: 2, unit: '$' },
  NG: { name: 'Natural Gas', cls: 'Commodity', dp: 3, unit: '$' },
  HG: { name: 'Copper /lb', cls: 'Commodity', dp: 3, unit: '$' },
  // Rates / FX / crypto
  US10Y: { name: 'US 10Y Yield', cls: 'Rates', dp: 2, unit: '%' },
  DXY: { name: 'US Dollar Index', cls: 'Rates', dp: 2 },
  BTC: { name: 'Bitcoin', cls: 'Crypto', dp: 2, unit: '$' },
  // Stocks
  NVDA: { name: 'NVIDIA', cls: 'Stock', dp: 2, unit: '$' },
  AAPL: { name: 'Apple', cls: 'Stock', dp: 2, unit: '$' },
  MSFT: { name: 'Microsoft', cls: 'Stock', dp: 2, unit: '$' },
  TSLA: { name: 'Tesla', cls: 'Stock', dp: 2, unit: '$' },
  AMZN: { name: 'Amazon', cls: 'Stock', dp: 2, unit: '$' },
  GOOGL: { name: 'Alphabet', cls: 'Stock', dp: 2, unit: '$' },
  META: { name: 'Meta', cls: 'Stock', dp: 2, unit: '$' },
  GLD: { name: 'SPDR Gold Shares', cls: 'Stock', dp: 2, unit: '$' },
  NEM: { name: 'Newmont (gold miner)', cls: 'Stock', dp: 2, unit: '$' },
};

// Our symbols → backend tickers (yfinance, or "VN:" for vnstock/VCI).
const LIVE_TICKER = {
  SPX: '^GSPC', NDX: '^NDX', DJI: '^DJI', RUT: '^RUT', VIX: '^VIX',
  FTSE: '^FTSE', N225: '^N225', XAU: 'GC=F', XAG: 'SI=F', WTI: 'CL=F',
  NG: 'NG=F', HG: 'HG=F', US10Y: '^TNX', DXY: 'DX-Y.NYB', BTC: 'BTC-USD',
  NVDA: 'NVDA', AAPL: 'AAPL', MSFT: 'MSFT', TSLA: 'TSLA', AMZN: 'AMZN',
  GOOGL: 'GOOGL', META: 'META', GLD: 'GLD', NEM: 'NEM',
  DAX: '^GDAXI', CAC: '^FCHI', HSI: '^HSI', SSE: '000001.SS', KOSPI: '^KS11',
  VNINDEX: 'VN:VNINDEX', VN30: 'VN:VN30', HNXINDEX: 'VN:HNXINDEX', UPCOMINDEX: 'VN:UPCOMINDEX', VNM: 'VN:VNM', FPT: 'VN:FPT',
  HPG: 'VN:HPG', VCB: 'VN:VCB', VIC: 'VN:VIC', MWG: 'VN:MWG',
};

const loadCustomInstruments = () => {
  try {
    const s = JSON.parse(localStorage.getItem(HOME_CUSTOM_KEY));
    return s && typeof s === 'object' ? s : {};
  } catch { return {}; }
};
const registerInstrument = (sym, inst) => {
  INSTRUMENTS[sym] = inst;
  if (inst.live) LIVE_TICKER[sym] = inst.live;
};
Object.entries(loadCustomInstruments()).forEach(([sym, inst]) => {
  if (!INSTRUMENTS[sym] && inst && typeof inst.name === 'string') registerInstrument(sym, inst);
});
const saveCustomInstrument = (sym, inst) => {
  registerInstrument(sym, inst);
  try {
    const all = loadCustomInstruments();
    all[sym] = inst;
    localStorage.setItem(HOME_CUSTOM_KEY, JSON.stringify(all));
  } catch { /* storage blocked */ }
};

// Markets a typed ticker can be looked up on, in the order offered.
const CUSTOM_MARKETS = [
  { key: 'vn', label: 'Vietnam stock', cls: 'Vietnam', live: sym => `VN:${sym}`, unit: undefined },
  { key: 'us', label: 'US stock', cls: 'Stock', live: sym => sym, unit: '$' },
];

const DEFAULT_WATCH = ['VNINDEX', 'VN30', 'FPT', 'VCB', 'HPG', 'XAU', 'SPX', 'US10Y'];

const loadWatch = () => {
  try {
    const s = JSON.parse(localStorage.getItem(HOME_WATCH_KEY));
    if (Array.isArray(s) && s.length) return s.filter(x => INSTRUMENTS[x]);
  } catch { /* fall through */ }
  return DEFAULT_WATCH;
};
const saveWatch = (watch) => {
  try { localStorage.setItem(HOME_WATCH_KEY, JSON.stringify(watch)); } catch { /* storage blocked */ }
};

const marketOf = (sym) => LIVE_TICKER[sym] || sym;

// VN stocks are quoted in nghìn đồng → shown ×1000 in đồng; VN indices are points.
const isVnStock = (sym) => {
  const m = LIVE_TICKER[sym];
  return !!m && m.startsWith('VN:') && !VN_INDEX_CODES.has(m.slice(3));
};

export {
  INSTRUMENTS, LIVE_TICKER, CUSTOM_MARKETS, DEFAULT_WATCH,
  loadWatch, saveWatch, saveCustomInstrument, marketOf, isVnStock,
};
