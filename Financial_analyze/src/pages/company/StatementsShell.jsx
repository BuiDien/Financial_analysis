// Statements page frame (title, subtitle, primary action) and the "Add statement" hand-off.

import React from 'react';
import { handoff } from '../../handoff.js';
import './company.css';

// Jump to OCR Inbox with the company pre-set; the inbox asks for year, period and scope.
const hxAddStatement = (ticker, setPage) => {
  handoff.ocrTarget = ticker ? { ticker } : null;
  setPage && setPage('ocr-inbox');
};

const StatementsShell = ({ sub, action, children }) => (
  <div className="page co-page">
    <div className="page-header">
      <div>
        <h1 className="page-title">Financial statements.</h1>
        <p className="page-sub">{sub}</p>
      </div>
      {action}
    </div>
    {children}
  </div>
);

export { StatementsShell, hxAddStatement };
