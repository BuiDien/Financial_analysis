// Company › Statements. Live when the backend answers and at least one company has verified
// history; otherwise an empty / offline state. Only verified data is shown — no demo numbers.
// Values are integers in đồng from the API, shown in tỷ đồng.

import React from 'react';
import { handoff } from '../../handoff.js';
import { HelixAPI, useApiLive } from '../../api-client.jsx';
import { useQuery } from '../../lib/query.js';
import { Button, EmptyState, SkeletonText } from '../../ui';
import { CompanyHistory } from './CompanyHistory.jsx';
import { StatementsShell, hxAddStatement } from './StatementsShell.jsx';

const PageStatements = ({ setPage, ticker = null }) => {
  // Company list from the shared query cache; refetched when the backend comes back.
  const { live, checked } = useApiLive();
  const companiesQ = useQuery(['history', 'companies'], () => HelixAPI.historyCompanies(), { enabled: live });
  const state = !checked ? { mode: 'checking', companies: [] }
    : !live || (companiesQ.error && companiesQ.data === undefined) ? { mode: 'offline', companies: [] }
      : companiesQ.data === undefined ? { mode: 'checking', companies: [] }
        : { mode: 'live', companies: companiesQ.data || [] };
  // Ticker from the route (#/company/:ticker/statements), or handed over by another page.
  // Read once; clearing it ("See companies with statements") falls back to the company list.
  const [wanted, setWanted] = React.useState(() => {
    const hint = ticker || handoff.statementsTicker;
    handoff.statementsTicker = null;
    return hint ? String(hint).toUpperCase().replace(/^VN:/, '') : null;
  });

  const addBtn = (t) => <Button variant="primary" icon="plus" onClick={() => hxAddStatement(t, setPage)}>Add statement</Button>;

  if (state.mode === 'checking') {
    return <StatementsShell sub="Looking for company history…"><SkeletonText lines={4} /></StatementsShell>;
  }
  if (state.mode === 'offline') {
    return (
      <StatementsShell sub="Company history from verified OCR statements">
        <EmptyState title="Can't reach the backend" description="Start the backend to see verified financial statements." />
      </StatementsShell>
    );
  }
  const { companies } = state;
  const hasWanted = wanted && companies.some(c => c.ticker === wanted);
  if (wanted && !hasWanted) {
    return (
      <StatementsShell sub={`${wanted} · no verified statements yet`} action={addBtn(wanted)}>
        <EmptyState title={`No statements for ${wanted} yet`}
          description={<>Found {wanted}'s financial report on the company website? Use <b>Add statement</b>, choose the year and quarter,
            and drop the PDF into OCR Inbox. After you check it and use <b>Add to history</b>, the numbers show up here.</>}
          action={companies.length > 0 ? <Button onClick={() => setWanted(null)}>See companies with statements ({companies.length})</Button> : undefined} />
      </StatementsShell>
    );
  }
  if (!companies.length) {
    return (
      <StatementsShell sub="Company history from verified OCR statements" action={addBtn(null)}>
        <EmptyState title="No statements yet"
          description={<>Pick a stock in Screener and open <b>Financials</b>, or use <b>Add statement</b> to upload a company's financial report.</>} />
      </StatementsShell>
    );
  }
  return <CompanyHistory companies={companies} wanted={hasWanted ? wanted : null} setPage={setPage} />;
};

export { PageStatements };
