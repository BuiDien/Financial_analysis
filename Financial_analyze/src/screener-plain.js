// Screener in plain language: rule names/sentences/help for non-finance users,
// and the Easy / Normal / Strict levels. Plain JS (no JSX) so it loads before the
// Babel pages and can be tested with node (scripts/test-screener-plain.js).
(function (root) {
  // name: plain rule name · short: table column · say(cfg): the rule as a sentence · help: why it matters
  const PLAIN = {
    roe_years: { name: "Makes good profit from owners' money", short: 'Profit on equity',
      say: c => `Earned at least ${c.x} đồng per 100 đồng of owners' money, every year for ${c.n} years.`,
      help: 'Return on equity (ROE). Most listed VN companies earn 8–13; above 15 is excellent.' },
    profit_growth: { name: 'Profit is growing', short: 'Profit growth',
      say: c => `Profit grew at least ${c.x}% a year on average over ${c.n} years.`,
      help: 'Average yearly growth of net profit. The typical liquid VN stock grows ~13% a year.' },
    profit_growth_min: { name: 'Profit grows every year', short: 'Worst year',
      say: c => `Profit changed by at least ${c.x}% in every one of the last ${c.n} years — no bad year.`,
      help: 'Catches companies whose average only looks good because of one lucky year.' },
    revenue_growth: { name: 'Sales are growing', short: 'Sales growth',
      say: c => `Sales grew at least ${c.x}% a year on average over ${c.n} years.`,
      help: 'Revenue growth. Profit can rise for a while by cutting costs; lasting growth needs sales.' },
    debt_to_equity: { name: 'Not drowning in debt', short: 'Debt',
      say: c => `Borrows less than ${c.x} đồng for each đồng the owners put in.`,
      help: 'Bank loans and bonds ÷ equity. Typical VN company ~0.6; above 1.5 is risky when rates rise.' },
    ocf_to_profit: { name: 'Profit turns into real cash', short: 'Cash vs profit',
      say: c => `Over ${c.n} years, brought in at least ${c.x} đồng of cash per 100 đồng of reported profit.`,
      help: 'Profit on paper must become cash. A low number can mean customers are not paying.' },
    pe_vs_industry: { name: 'Not expensive vs similar companies', short: 'Price vs peers',
      say: c => `Price-to-earnings is at most ${c.x}% of the typical company in its industry.`,
      help: '100% = priced like its peers; 80% = 20% cheaper than peers for each đồng of profit.' },
    pb: { name: 'Cheap vs what it owns', short: 'Price vs assets',
      say: c => `Share price is at most ${c.x}× the company's net assets per share.`,
      help: 'Price-to-book (P/B). Typical VN stock ~1.2; below 1 means priced under its book value.' },
    dividend_yield: { name: 'Pays a good cash dividend', short: 'Dividend',
      say: c => `Paid cash dividends of at least ${c.x}% of the share price last year.`,
      help: 'Dividend yield. Typical VN cash yield is 2–4%; many firms pay in shares instead.' },
    traded_value: { name: 'Easy to buy and sell', short: 'Daily trading',
      say: c => `At least ${c.x} billion đồng of its shares trade on an average day.`,
      help: 'Thinly traded stocks are hard to sell and easy to push around.' },
    market_cap: { name: 'Big enough company', short: 'Company size',
      say: c => `The company is worth at least ${c.x} billion đồng on the market.`,
      help: 'Market capitalisation: share price × number of shares.' },
    bank_npl: { name: 'Few bad loans', short: 'Bad loans',
      say: c => `At most ${c.x}% of the bank's loans are bad (not being repaid).`,
      help: 'Non-performing loans (NPL). Typical VN bank ~2.2%; above 3% is a warning.' },
    bank_nim: { name: 'Earns well on lending', short: 'Lending margin',
      say: c => `Earns at least ${c.x}% more on its loans than it pays on deposits.`,
      help: 'Net interest margin (NIM). Typical VN bank ~2.8%.' },
    bank_cir: { name: 'Runs efficiently', short: 'Cost vs income',
      say: c => `Spends at most ${c.x} đồng in running costs for each 100 đồng of income.`,
      help: 'Cost-to-income ratio (CIR). Typical VN bank ~32%.' },
    bank_car: { name: 'Has a safety cushion', short: 'Safety capital',
      say: c => `Keeps capital of at least ${c.x}% of its risky assets.`,
      help: 'Capital adequacy ratio (CAR). The legal minimum is 8%.' },
    receivable_days_change: { name: "Customers aren't paying slower", short: 'Collection days',
      say: c => `Takes no more than ${c.x} extra days to collect payment than ${c.n} years ago.`,
      help: 'Rising collection days can mean sales are booked but cash never arrives — a common warning sign in VN property and construction.' },
    inventory_days_change: { name: "Goods aren't piling up", short: 'Stock days',
      say: c => `Goods sit unsold at most ${c.x} days longer than ${c.n} years ago.`,
      help: 'Inventory that sits longer can mean sales are slowing.' },
    gross_margin_change: { name: 'Keeps its pricing power', short: 'Margin change',
      say: c => (c.x < 0
        ? `Gross margin fell by no more than ${-c.x} points over ${c.n} years.`
        : `Gross margin rose by at least ${c.x} points over ${c.n} years.`),
      help: 'Gross margin = what is left of each sale after the cost of the goods. Falling margin means competition or rising costs.' },
    share_dilution: { name: 'Not printing lots of new shares', short: 'New shares',
      say: c => `Number of shares grew at most ${c.x}% a year over ${c.n} years.`,
      help: 'New shares sold for cash spread the same profit over more shares. Careful: bonus shares and dividends paid in shares also count here, and those take nothing from you — this rule would wrongly drop FPT, SAB or MCH, so it is off in the starters.' },
    foreign_room: { name: 'Foreign investors can still buy', short: 'Foreign room',
      say: c => `At least ${c.x}% of the foreign ownership limit is still free.`,
      help: 'When the foreign limit is full, foreign funds cannot buy more shares on the exchange.' },
    rsi: { name: 'Sold off hard recently', short: 'Selling pressure',
      say: c => `Momentum indicator (RSI) is below ${c.x} — the stock has been sold heavily.`,
      help: 'RSI runs 0–100. Below 30 = oversold, 50 = neutral, above 70 = overheated.' },
    price_drop: { name: 'Price just dropped', short: 'Recent drop',
      say: c => `Price fell at least ${c.x}% in the last ${c.d} trading days.`,
      help: 'A sharp short drop in a good company can be a buying chance — or bad news. Check the news.' },
    volume_spike: { name: 'Heavy trading volume', short: 'Volume',
      say: c => `Today's volume is at least ${c.x}× the usual (20-day average).`,
      help: 'Very heavy volume during a drop often marks panic selling.' },
  };

  const STRATEGY_DESC = {
    quality: 'Strong, growing, healthy companies',
    deep_value: 'Decent companies priced cheaply',
    dividend: 'Companies that pay you cash every year',
    banks: 'Safe, profitable banks',
  };

  // One "step" per rule for Easy / Strict, in the rule's own unit.
  const STEPS = {
    roe_years: 3, profit_growth: 5, profit_growth_min: 5, revenue_growth: 5, debt_to_equity: 0.3,
    ocf_to_profit: 20, pe_vs_industry: 20, pb: 0.5, dividend_yield: 1, traded_value: 2,
    market_cap: 500, bank_npl: 1, bank_nim: 0.5, bank_cir: 5, bank_car: 1,
    receivable_days_change: 10, inventory_days_change: 15, gross_margin_change: 2,
    share_dilution: 3, foreign_room: 3, rsi: 5, price_drop: 3, volume_spike: 0.2,
  };

  const LEVELS = ['easy', 'normal', 'strict'];
  const LEVEL_LABEL = { easy: 'Easy', normal: 'Normal', strict: 'Strict', custom: 'Custom' };

  const round = (v, step) => {
    const dec = String(step).includes('.') ? String(step).split('.')[1].length : 0;
    return Number(v.toFixed(dec));
  };

  // +1 = raising x makes the rule stricter; -1 = lowering x makes it stricter.
  const strictDir = (spec) => (spec.kind === 'at_most' ? -1 : 1);

  // The strategy's saved rules (Normal) moved one step looser (easy) or tighter (strict).
  function applyLevel(catalog, baseRules, level) {
    const sign = level === 'strict' ? 1 : level === 'easy' ? -1 : 0;
    return baseRules.map((r) => {
      const spec = catalog[r.id];
      const step = STEPS[r.id];
      if (!sign || !spec || !step || typeof r.x !== 'number' || !spec.params || !spec.params.x) return { ...r };
      const p = spec.params.x;
      let x = round(r.x + sign * strictDir(spec) * step, step);
      if (p.min !== undefined) x = Math.max(p.min, x);
      if (p.max !== undefined) x = Math.min(p.max, x);
      return { ...r, x };
    });
  }

  const xs = (rules) => JSON.stringify(rules.map(r => [r.id, r.on !== false, typeof r.x === 'number' ? r.x : r.x === undefined ? null : Number(r.x)]));

  // Which level the working rules match, else 'custom'. Only on/off and x are compared:
  // other params (n, d, scope) must equal the saved ones for a level to match.
  function detectLevel(catalog, baseRules, rules) {
    const other = (list) => JSON.stringify(list.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'x'))));
    const byId = (list) => [...list].sort((a, b) => (a.id < b.id ? -1 : 1));
    const cur = byId(rules);
    for (const lv of LEVELS) {
      const want = byId(applyLevel(catalog, baseRules, lv));
      if (want.length === cur.length && xs(want) === xs(cur) && other(want) === other(cur)) return lv;
    }
    return 'custom';
  }

  function sentence(id, cfg) {
    const p = PLAIN[id];
    try { return p ? p.say(cfg) : id; } catch (e) { return p.name; }
  }

  function scopeSummary(scope) {
    if (!scope) return '';
    const parts = [];
    const b = { exclude: 'Skipping banks', no_financials: 'Skipping banks, brokers and insurers', only: 'Banks only' }[scope.banks];
    if (b) parts.push(b);
    if (scope.exchanges && scope.exchanges.length) parts.push(`only ${scope.exchanges.join(' / ')}`);
    if ((scope.flagged || 'exclude') === 'exclude') parts.push('hiding stocks under exchange warning or control');
    return parts.length ? parts.join(' · ') : 'All companies on HOSE, HNX and UPCOM';
  }

  // Result cell status. "n/a" = the rule does not apply to this company type (e.g. a bank-only
  // rule on a non-bank): neutral, never counted as a fail or as skipped/missing data.
  const NA_TIP = 'Not applicable to this company type';
  const NA_STATUSES = ['n/a', 'na', 'not_applicable'];
  function cellStatus(cell) {
    if (!cell) return 'empty';
    const s = String(cell.status || '').toLowerCase();
    return NA_STATUSES.includes(s) ? 'n/a' : (s || 'pass');
  }
  const isNotApplicable = (cell) => cellStatus(cell) === 'n/a';
  // Rules on a result row that did not apply to it.
  const notApplicableIds = (row) => Object.keys((row && row.rules) || {}).filter(id => isNotApplicable(row.rules[id]));

  const api = { PLAIN, STRATEGY_DESC, STEPS, LEVELS, LEVEL_LABEL, applyLevel, detectLevel, sentence, scopeSummary,
    NA_TIP, cellStatus, isNotApplicable, notApplicableIds };
  root.ScrPlain = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
