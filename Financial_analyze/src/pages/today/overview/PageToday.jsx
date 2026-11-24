// Today — the landing page. VN-first market pulse, holdings snapshot, triggered
// alerts, news, the watch board and the active watchlist. Live data only:
// offline every section shows an honest empty state.

import React from 'react';
import { useApiLive } from '../../../api-client.jsx';
import { Icon } from '../../../icons.jsx';
import { WatchBoard } from '../watch-board/WatchBoard.jsx';
import { WatchlistSection } from '../watchlist/WatchlistSection.jsx';
import { MarketPulse } from './MarketPulse.jsx';
import { HoldingsSnapshot } from './HoldingsSnapshot.jsx';
import { TriggeredAlerts } from './TriggeredAlerts.jsx';
import { NewsHits } from './NewsHits.jsx';
import { HcmClock, OFFLINE_TEXT, todayDate } from './SectionStatus.jsx';
import '../today.css';

const PageToday = ({ setPage, setActiveAsset }) => {
  const { live } = useApiLive();
  const nav = { setPage, setActiveAsset };
  return (
    <div className="page td-page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Today.</h1>
          <p className="page-sub">{todayDate()} · Vietnam market first{live ? '' : ' · backend offline'}</p>
        </div>
        <HcmClock live={live} />
      </header>

      {!live && (
        <div className="td-offline" role="status">
          <Icon name="server" size={14} /> {OFFLINE_TEXT}. The app reconnects automatically.
        </div>
      )}

      <MarketPulse />

      <div className="td-grid">
        <div className="td-col">
          <HoldingsSnapshot {...nav} />
          <TriggeredAlerts {...nav} />
        </div>
        <NewsHits setPage={setPage} />
      </div>

      <WatchBoard {...nav} />
      <WatchlistSection {...nav} />
    </div>
  );
};

export { PageToday };
