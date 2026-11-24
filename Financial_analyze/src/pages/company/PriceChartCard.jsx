// Overview price chart: candle/area switch, candle timeframe, my-trades markers toggle.

import React from 'react';
import { LWChart } from '../../lwchart.jsx';
import { Button, Card, EmptyState, Segmented, Skeleton, useMediaQuery } from '../../ui';
import { DETAIL_RANGES, fmtOffset } from './market-utils.js';

const TYPE_OPTIONS = [{ value: 'candle', label: 'Candles' }, { value: 'area', label: 'Area' }];
const RANGE_OPTIONS = Object.keys(DETAIL_RANGES);

const PriceChartCard = ({
  activeAsset, live, vn, chartType, setChartType, range, setRange, chartState, olderState, ohlc,
  markers, onReachStart, marketOff, currency, myTicker, showTrades, setShowTrades,
}) => {
  const ready = chartState === 'ready' && ohlc;
  const CHART_H = useMediaQuery('(max-width: 760px)') ? 320 : 420;   // matches .co-chart height
  return (
    <Card className="co-chart-card" title="Price chart"
      subtitle={<span data-tip="Chart times are the exchange's local time">{vn ? 'Vietnam time' : 'Exchange time'} ({fmtOffset(marketOff)})</span>}
      actions={(
        <div className="co-chart-tools">
          <Segmented size="sm" ariaLabel="Chart type" value={chartType} onChange={setChartType} options={TYPE_OPTIONS} />
          <div className="co-range-scroll">
            <Segmented size="sm" ariaLabel="Candle timeframe" value={range} onChange={setRange} options={RANGE_OPTIONS} />
          </div>
          {myTicker && (
            <Button size="sm" variant="ghost" aria-pressed={showTrades} className={showTrades ? 'co-trades-on' : undefined}
              onClick={() => setShowTrades(v => !v)} title="Show my buys (▲) and sells (▼) on the chart">
              My trades · {myTicker.orders_buy + myTicker.orders_sell}
            </Button>
          )}
        </div>
      )}
      flush>
      <div className="co-chart">
        {ready && olderState !== 'idle' && (
          <div className="co-chart-note">{olderState === 'loading' ? 'Loading older bars…' : 'Start of available history'}</div>
        )}
        {ready ? (
          <LWChart data={ohlc} type={chartType} height={CHART_H} volume range={range} markers={markers} onReachStart={onReachStart} currency={currency} />
        ) : chartState === 'loading' ? (
          <div className="co-chart-empty" aria-busy="true"><Skeleton width="100%" height={CHART_H - 40} /></div>
        ) : (
          <div className="co-chart-empty">
            <EmptyState size="sm" plain
              title={live ? 'No price history' : 'Backend offline'}
              description={live ? `No price history for ${activeAsset} in this range.` : 'Connect the backend to load price history.'} />
          </div>
        )}
      </div>
    </Card>
  );
};

export { PriceChartCard };
