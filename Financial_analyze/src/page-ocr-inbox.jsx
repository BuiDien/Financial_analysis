// OCR Inbox — upload unlabeled PDFs, send them to a paired worker, review every
// returned row against its source, then label and publish verified data.

const OCR_STATUS = {
  uploaded: ['Uploaded', 'var(--text-muted)'], queued: ['Queued', '#B45309'],
  held: ['Held', '#B45309'],
  processing: ['Processing', '#1D4ED8'], ready_for_review: ['Ready for review', '#7C3AED'],
  reviewing: ['Reviewing', '#7C3AED'], verified: ['Verified · needs labels', '#15803D'],
  ready_to_publish: ['Ready to publish', '#15803D'], published: ['Published', '#15803D'],
  failed: ['Failed', '#B91C1C'],
};

const fmtInboxBytes = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

const InboxStatus = ({ status }) => {
  const spec = OCR_STATUS[status] || [status, 'var(--text-muted)'];
  return <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: spec[1] }}>{spec[0]}</span>;
};

const splitMarkdownTableRow = line => {
  const escapedPipe = '\u0000HELIX_PIPE\u0000';
  let value = String(line || '').trim().replace(/\\\|/g, escapedPipe);
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);
  return value.split('|').map(cell => cell.replaceAll(escapedPipe, '|').trim());
};

const isMarkdownTableSeparator = line => {
  if (!String(line || '').includes('|')) return false;
  const cells = splitMarkdownTableRow(line);
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell.replace(/\s/g, '')));
};

const safeMarkdownHref = href => {
  try {
    const url = new URL(href, window.location.href);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
};

const MarkdownInline = ({ text, prefix }) => {
  const tokens = String(text || '').split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);
  return <>{tokens.map((token, index) => {
    const key = `${prefix}-${index}`;
    if (token.startsWith('`') && token.endsWith('`')) return <code key={key} style={{ padding: '1px 4px', borderRadius: 3, background: 'var(--bg-sunken)', fontFamily: 'var(--font-mono)', fontSize: '.92em' }}>{token.slice(1, -1)}</code>;
    if (token.startsWith('**') && token.endsWith('**')) return <strong key={key}>{token.slice(2, -2)}</strong>;
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const href = safeMarkdownHref(link[2]);
      return href ? <a key={key} href={href} target="_blank" rel="noreferrer">{link[1]}</a> : <span key={key}>{link[1]}</span>;
    }
    return <React.Fragment key={key}>{token}</React.Fragment>;
  })}</>;
};

const safeTableSpan = value => {
  const parsed = Number.parseInt(value || '1', 10);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(1, parsed)) : 1;
};

const HTMLTablePreview = ({ html }) => {
  if (typeof window.DOMParser !== 'function') {
    return <pre style={{ margin: '0 0 14px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{html}</pre>;
  }

  const document = new window.DOMParser().parseFromString(String(html || ''), 'text/html');
  const tables = Array.from(document.body.querySelectorAll('table'));
  if (!tables.length) return <p style={{ margin: '0 0 12px' }}>{document.body.textContent || ''}</p>;

  return <>{tables.map((table, tableIndex) => {
    const rows = Array.from(table.querySelectorAll('tr')).map(row => Array.from(row.children)
      .filter(cell => ['TD', 'TH'].includes(cell.tagName))
      .map(cell => ({
        text: (cell.textContent || '').replace(/\s+/g, ' ').trim(),
        header: cell.tagName === 'TH',
        rowSpan: safeTableSpan(cell.getAttribute('rowspan')),
        colSpan: safeTableSpan(cell.getAttribute('colspan')),
        align: ['left', 'center', 'right'].includes(cell.style.textAlign) ? cell.style.textAlign : null,
      })));
    const firstRowSpan = rows[0]?.some(cell => cell.rowSpan > 1);
    const headerRows = rows[0]?.some(cell => cell.header) ? 1 : firstRowSpan ? 2 : 0;

    return <div key={`html-table-${tableIndex}`} style={{ overflowX: 'auto', margin: '0 0 16px', border: '1px solid var(--border)', borderRadius: 6 }}>
      <table style={{ width: '100%', minWidth: 560, tableLayout: 'auto', borderCollapse: 'collapse', fontSize: 12 }}>
        <tbody>{rows.map((row, rowIndex) => <tr key={`row-${rowIndex}`}>
          {row.map((cell, cellIndex) => {
            const isHeader = cell.header || rowIndex < headerRows;
            const numeric = /^[-+()\d.,%\s]+$/.test(cell.text) && /\d/.test(cell.text);
            const Cell = isHeader ? 'th' : 'td';
            return <Cell
              key={`cell-${cellIndex}`}
              rowSpan={cell.rowSpan}
              colSpan={cell.colSpan}
              scope={Cell === 'th' ? 'col' : undefined}
              style={{
                padding: '7px 10px',
                minWidth: cellIndex === 0 ? 220 : 105,
                textAlign: cell.align || (numeric ? 'right' : 'left'),
                verticalAlign: 'top',
                overflowWrap: 'anywhere',
                borderBottom: rowIndex < rows.length - 1 ? '1px solid var(--border)' : 'none',
                borderRight: cellIndex < row.length - 1 ? '1px solid var(--border)' : 'none',
                background: isHeader ? 'var(--bg-sunken)' : 'transparent',
                fontWeight: isHeader ? 700 : 400,
                fontFamily: numeric ? 'var(--font-mono)' : 'inherit',
                fontVariantNumeric: 'tabular-nums',
              }}
            >{cell.text}</Cell>;
          })}
        </tr>)}</tbody>
      </table>
    </div>;
  })}</>;
};

const MarkdownPreview = ({ markdown }) => {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let index = 0;

  const startsBlock = position => {
    const line = lines[position] || '';
    const next = lines[position + 1] || '';
    return !line.trim()
      || /^```/.test(line.trim())
      || /^<table(?:\s|>)/i.test(line.trim())
      || /^#{1,6}\s+/.test(line)
      || /^\s*([-*+]\s+|\d+\.\s+|>\s?)/.test(line)
      || /^\s*((-{3,})|(\*{3,})|(_{3,}))\s*$/.test(line)
      || (line.includes('|') && isMarkdownTableSeparator(next));
  };

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    if (/^```/.test(line.trim())) {
      const language = line.trim().slice(3).trim();
      const code = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index].trim())) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(<pre key={`code-${index}`} style={{ margin: '0 0 14px', padding: 12, overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-sunken)', fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.55 }}><code data-language={language || undefined}>{code.join('\n')}</code></pre>);
      continue;
    }

    if (/^<table(?:\s|>)/i.test(line.trim())) {
      const html = [line];
      index += 1;
      while (index < lines.length && !html.some(value => /<\/table\s*>/i.test(value))) {
        html.push(lines[index]);
        index += 1;
      }
      blocks.push(<HTMLTablePreview key={`html-table-${index}`} html={html.join('\n')} />);
      continue;
    }

    if (line.includes('|') && isMarkdownTableSeparator(lines[index + 1])) {
      const headers = splitMarkdownTableRow(line);
      const separators = splitMarkdownTableRow(lines[index + 1]);
      const alignments = separators.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        const cells = splitMarkdownTableRow(lines[index]);
        rows.push(headers.map((_, cellIndex) => cells[cellIndex] || ''));
        index += 1;
      }
      blocks.push(
        <div key={`table-${index}`} style={{ overflowX: 'auto', margin: '0 0 16px', border: '1px solid var(--border)', borderRadius: 6 }}>
          <table style={{ width: '100%', minWidth: Math.max(440, headers.length * 130), borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>{headers.map((header, cellIndex) => <th key={`h-${cellIndex}`} style={{ padding: '8px 10px', textAlign: alignments[cellIndex] || 'left', verticalAlign: 'bottom', background: 'var(--bg-sunken)', borderBottom: '1px solid var(--border-strong)', borderRight: cellIndex < headers.length - 1 ? '1px solid var(--border)' : 'none', fontWeight: 700 }}><MarkdownInline text={header} prefix={`h-${index}-${cellIndex}`} /></th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => <tr key={`r-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`c-${cellIndex}`} style={{ padding: '7px 10px', textAlign: alignments[cellIndex] || 'left', verticalAlign: 'top', borderBottom: rowIndex < rows.length - 1 ? '1px solid var(--border)' : 'none', borderRight: cellIndex < headers.length - 1 ? '1px solid var(--border)' : 'none', fontFamily: /^[-+()\d.,%\s]+$/.test(cell) ? 'var(--font-mono)' : 'inherit', fontVariantNumeric: 'tabular-nums' }}><MarkdownInline text={cell} prefix={`c-${index}-${rowIndex}-${cellIndex}`} /></td>)}</tr>)}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const Heading = `h${level}`;
      blocks.push(<Heading key={`heading-${index}`} style={{ margin: level <= 2 ? '18px 0 9px' : '14px 0 7px', fontFamily: level <= 2 ? 'var(--font-serif)' : 'inherit', fontSize: level === 1 ? 22 : level === 2 ? 18 : level === 3 ? 15 : 13, lineHeight: 1.3 }}><MarkdownInline text={heading[2]} prefix={`heading-${index}`} /></Heading>);
      index += 1;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, ''));
        index += 1;
      }
      blocks.push(<ul key={`ul-${index}`} style={{ margin: '0 0 12px', paddingLeft: 22 }}>{items.map((item, itemIndex) => <li key={itemIndex} style={{ marginBottom: 4 }}><MarkdownInline text={item} prefix={`ul-${index}-${itemIndex}`} /></li>)}</ul>);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ''));
        index += 1;
      }
      blocks.push(<ol key={`ol-${index}`} style={{ margin: '0 0 12px', paddingLeft: 24 }}>{items.map((item, itemIndex) => <li key={itemIndex} style={{ marginBottom: 4 }}><MarkdownInline text={item} prefix={`ol-${index}-${itemIndex}`} /></li>)}</ol>);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push(<blockquote key={`quote-${index}`} style={{ margin: '0 0 12px', padding: '7px 11px', borderLeft: '3px solid var(--accent)', background: 'var(--bg-sunken)', color: 'var(--text-muted)' }}><MarkdownInline text={quote.join(' ')} prefix={`quote-${index}`} /></blockquote>);
      continue;
    }

    if (/^\s*((-{3,})|(\*{3,})|(_{3,}))\s*$/.test(line)) {
      blocks.push(<hr key={`hr-${index}`} style={{ margin: '16px 0', border: 0, borderTop: '1px solid var(--border)' }} />);
      index += 1;
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && !startsBlock(index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push(<p key={`p-${index}`} style={{ margin: '0 0 12px', lineHeight: 1.65 }}><MarkdownInline text={paragraph.join(' ')} prefix={`p-${index}`} /></p>);
  }

  if (!blocks.length) return <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>This page contains no OCR text.</div>;
  return <div style={{ fontSize: 12, color: 'var(--text)' }}>{blocks}</div>;
};

const PageOCRInbox = ({ setPage }) => {
  const focusedReviewId = new URLSearchParams(window.location.search).get('ocrReview');
  const [items, setItems] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [uploading, setUploading] = React.useState(false);
  const inputRef = React.useRef(null);

  const refresh = React.useCallback(async () => {
    if (focusedReviewId) return;
    if (!window.HelixAPI?.live) { setLoading(false); return; }
    try { setItems(await window.HelixAPI.ocrInbox()); }
    catch (e) { window.toast?.(`Could not load OCR Inbox: ${e.message}`, { type: 'error' }); }
    finally { setLoading(false); }
  }, [focusedReviewId]);

  React.useEffect(() => {
    if (focusedReviewId) return undefined;
    refresh();
    const timer = setInterval(refresh, 1800);
    return () => clearInterval(timer);
  }, [focusedReviewId, refresh]);

  const uploadFiles = async (files, allowDuplicate = false) => {
    if (!files?.length) return;
    if (files.length > 20) { window.toast?.('Choose at most 20 PDFs', { type: 'error' }); return; }
    setUploading(true);
    try {
      await window.HelixAPI.ocrInboxUpload(files, allowDuplicate);
      window.toast?.(`${files.length} PDF${files.length === 1 ? '' : 's'} added to the OCR Inbox`, { type: 'success' });
      await refresh();
    } catch (e) {
      if (e.status === 409 && window.confirm(`${e.message}. Upload another OCR copy anyway?`)) {
        await uploadFiles(files, true);
      } else window.toast?.(e.message || 'Upload failed', { type: 'error' });
    } finally { setUploading(false); if (inputRef.current) inputRef.current.value = ''; }
  };

  const act = async (item, action) => {
    try {
      if (action === 'run') await window.HelixAPI.ocrInboxRun(item.id);
      if (action === 'retry') await window.HelixAPI.ocrInboxRetry(item.id);
      if (action === 'cancel') await window.HelixAPI.ocrInboxCancel(item.id);
      if (action === 'delete' && window.confirm(`Delete ${item.filename} and its OCR history?`)) await window.HelixAPI.ocrInboxDelete(item.id);
      await refresh();
    } catch (e) { window.toast?.(e.message, { type: 'error' }); }
  };

  if (focusedReviewId) {
    const leaveReview = () => {
      const url = new URL(window.location.href);
      url.searchParams.delete('ocrReview');
      window.location.assign(url.toString());
    };
    return <OCRReviewWorkspace itemId={focusedReviewId} onBack={leaveReview} setPage={setPage} />;
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">OCR Inbox.</h1>
          <p className="page-sub">Send PDFs to the OCR worker before they become financial statements</p>
        </div>
        <button className="btn btn-primary" disabled={uploading || !window.HelixAPI?.live} onClick={() => inputRef.current?.click()}>
          <Icon name="plus" size={12} /> {uploading ? 'Uploading…' : 'Add PDFs'}
        </button>
        <input ref={inputRef} type="file" multiple accept=".pdf,application/pdf" style={{ display: 'none' }} onChange={e => uploadFiles(Array.from(e.target.files || []))} />
      </div>

      {!window.HelixAPI?.live && (
        <div className="card" style={{ padding: 24, color: 'var(--text-muted)' }}>The backend must be running to use the persistent OCR Inbox.</div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-header">
          <h3 className="card-title">Documents</h3>
          <span className="num" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{items.length} stored locally</span>
        </div>
        {loading ? <div style={{ padding: 32, color: 'var(--text-muted)' }}>Loading…</div> : items.length === 0 ? (
          <div onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); uploadFiles(Array.from(e.dataTransfer.files || [])); }}
            style={{ padding: 56, textAlign: 'center', color: 'var(--text-muted)', border: '2px dashed var(--border)', margin: 20, borderRadius: 8 }}>
            <Icon name="download" size={28} style={{ marginBottom: 12 }} />
            <div style={{ fontWeight: 600, color: 'var(--text)' }}>Drop financial-statement PDFs here</div>
            <div style={{ fontSize: 12, marginTop: 5 }}>No ticker or reporting period required yet</div>
          </div>
        ) : items.map(item => (
          <div key={item.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(220px,1.5fr) 150px 130px minmax(220px,auto)', gap: 16, alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.filename}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>{item.pages} pages · {fmtInboxBytes(item.size_bytes)}</div>
              {item.error && <div style={{ fontSize: 11, color: 'var(--neg)', marginTop: 4 }}>{item.error}</div>}
            </div>
            <div>
              <InboxStatus status={item.status} />
              {item.attempt && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{item.attempt.worker || 'Waiting for worker'} · {item.attempt.progress || 0}%</div>}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {item.review ? `${item.review.counts.resolved}/${item.review.counts.total} resolved` : 'Not reviewed'}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap' }}>
              {['uploaded', 'held', 'failed'].includes(item.status) && <button className="btn btn-primary" onClick={() => act(item, item.status === 'failed' ? 'retry' : 'run')}>{item.status === 'failed' ? 'Retry' : item.status === 'held' ? 'Resume OCR' : 'Run OCR'}</button>}
              {item.status === 'queued' && <button className="btn" onClick={() => act(item, 'cancel')}>Cancel</button>}
              {item.review && <a className="btn" href={(() => { const url = new URL(window.location.href); url.searchParams.set('ocrReview', item.id); return url.toString(); })()} target="_blank" rel="noopener noreferrer"><Icon name="eye" size={12} /> Open review</a>}
              {!item.published_filing_id && !['queued', 'processing'].includes(item.status) && <button className="btn" onClick={() => act(item, 'delete')}>Delete</button>}
              {item.published_filing_id && <button className="btn" onClick={() => setPage('statements')}>Open filing</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const OCRReviewWorkspace = ({ itemId, onBack, setPage }) => {
  const [item, setItem] = React.useState(null);
  const [review, setReview] = React.useState(null);
  const [selectedId, setSelectedId] = React.useState(null);
  const [editing, setEditing] = React.useState(null);
  const [drawing, setDrawing] = React.useState(false);
  const drawStart = React.useRef(null);

  const load = React.useCallback(async () => {
    const nextItem = await window.HelixAPI.ocrInboxItem(itemId);
    setItem(nextItem);
    if (nextItem.review) {
      const nextReview = await window.HelixAPI.ocrReview(nextItem.review.id);
      setReview(nextReview);
      setSelectedId(id => id || nextReview.rows[0]?.id || null);
    }
  }, [itemId]);

  React.useEffect(() => { load().catch(e => window.toast?.(e.message, { type: 'error' })); }, [load]);
  if (!item || !review) return <div className="page"><button className="btn" onClick={onBack}>← Inbox</button><div style={{ padding: 40 }}>Loading review…</div></div>;

  if (review.result_format === 'page_markdown_v2') {
    return <OCRMarkdownReviewWorkspace item={item} review={review} setReview={setReview} reload={load} onBack={onBack} />;
  }

  const selected = review.rows.find(row => row.id === selectedId) || review.rows[0];
  const evidence = selected ? (selected.reviewed || selected.raw) : null;
  const selectedBox = selected?.bbox;

  const updateReview = next => { setReview(next); setEditing(null); };
  const rowAction = async (row, action, data, reason) => {
    try { updateReview(await window.HelixAPI.ocrReviewAction(review.id, row.id, action, review.revision, data, reason)); }
    catch (e) { window.toast?.(e.message, { type: 'error' }); if (e.message?.includes('refresh')) load(); }
  };
  const reject = async row => {
    const reason = await window.askPrompt({ title: 'Reject OCR row', label: 'Reason', placeholder: 'Duplicate, header, irrelevant…', confirmText: 'Reject' });
    if (reason) rowAction(row, 'reject', null, reason);
  };

  const beginEdit = row => {
    const source = row.reviewed || row.raw;
    setEditing({ mode: 'correct', row, data: { ...source, bbox: { ...row.bbox }, page: row.page, confidence: row.confidence } });
  };
  const setField = (field, value) => setEditing(e => ({ ...e, data: { ...e.data, [field]: value } }));
  const saveEdit = async () => {
    const data = { ...editing.data, page: Number(editing.data.page), confidence: Number(editing.data.confidence) };
    try {
      if (editing.mode === 'manual') updateReview(await window.HelixAPI.ocrReviewAdd(review.id, review.revision, data));
      else await rowAction(editing.row, 'correct', data);
    } catch (e) { window.toast?.(e.message, { type: 'error' }); }
  };

  const pointerPos = e => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)) };
  };
  const finishDraw = e => {
    if (!drawing || !drawStart.current) return;
    const end = pointerPos(e), start = drawStart.current;
    const bbox = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
    setDrawing(false); drawStart.current = null;
    if (bbox.width < .01 || bbox.height < .01) return;
    setEditing({ mode: 'manual', data: { code: '', metric: '', section: 'balance', curr: '', prev: '', page: selected?.page || 1, confidence: 100, bbox } });
  };

  const verify = async () => {
    try { setReview(await window.HelixAPI.ocrReviewVerify(review.id, review.revision)); await load(); window.toast?.('OCR review verified', { type: 'success' }); }
    catch (e) { window.toast?.(e.message, { type: 'error' }); }
  };

  return (
    <div className="page" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="page-header" style={{ marginBottom: 14 }}>
        <div>
          <button className="card-action" onClick={onBack}>← OCR Inbox</button>
          <h1 className="page-title" style={{ marginTop: 8 }}>{item.filename}</h1>
          <p className="page-sub">{review.counts.resolved} of {review.counts.total} rows resolved · revision {review.revision}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => { setDrawing(true); setEditing(null); }}>Add missing row</button>
          <button className="btn btn-primary" disabled={review.counts.pending > 0 || ['verified', 'published'].includes(review.status)} onClick={verify}>Verify review</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(420px,1.15fr) minmax(440px,1fr)', gap: 14, flex: 1, minHeight: 0 }}>
        <div className="card" style={{ overflow: 'auto', padding: 12, background: '#383b40' }}>
          <div style={{ maxWidth: 850, margin: '0 auto', position: 'relative', lineHeight: 0, cursor: drawing ? 'crosshair' : 'default', userSelect: 'none' }}
            onMouseDown={e => { if (drawing) drawStart.current = pointerPos(e); }} onMouseUp={finishDraw}>
            <img src={window.HelixAPI.ocrInboxPageUrl(item.id, selected?.page || 1)} style={{ width: '100%', height: 'auto', display: 'block', background: 'white' }} />
            {selectedBox && !drawing && <div style={{ position: 'absolute', left: `${selectedBox.x * 100}%`, top: `${selectedBox.y * 100}%`, width: `${selectedBox.width * 100}%`, height: `${selectedBox.height * 100}%`, border: '2px solid #F97316', background: 'rgba(249,115,22,.14)', pointerEvents: 'none' }} />}
          </div>
          {drawing && <div style={{ color: 'white', textAlign: 'center', fontSize: 12, padding: 10 }}>Drag a rectangle around the missing source row</div>}
        </div>

        <div className="card" style={{ overflow: 'auto' }}>
          <div className="card-header"><h3 className="card-title">Extracted rows</h3><InboxStatus status={review.status} /></div>
          {review.rows.map(row => {
            const data = row.reviewed || row.raw;
            const active = row.id === selected?.id;
            return <div key={row.id} onClick={() => setSelectedId(row.id)} style={{ padding: '11px 14px', borderBottom: '1px solid var(--border)', background: active ? 'var(--accent-bg)' : 'transparent', cursor: 'pointer' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '52px 1fr 80px 80px', gap: 8, alignItems: 'center' }}>
                <span className="num" style={{ fontSize: 11 }}>{data.code || data.id}</span>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{data.metric || data.label}</span>
                <span className="num" style={{ textAlign: 'right', fontSize: 12 }}>{data.curr}</span>
                <span className="num" style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-muted)' }}>{data.prev || '—'}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 7 }}>
                <InboxStatus status={row.status} /><span style={{ fontSize: 10, color: 'var(--text-muted)' }}>p.{row.page} · {row.confidence}%</span><span style={{ flex: 1 }} />
                {!['verified', 'published'].includes(review.status) && <>
                  <button className="card-action" onClick={e => { e.stopPropagation(); rowAction(row, 'approve'); }}>Approve</button>
                  <button className="card-action" onClick={e => { e.stopPropagation(); beginEdit(row); }}>Correct</button>
                  <button className="card-action" onClick={e => { e.stopPropagation(); reject(row); }}>Reject</button>
                  {row.status !== 'pending' && <button className="card-action" onClick={e => { e.stopPropagation(); rowAction(row, 'restore'); }}>Reset</button>}
                </>}
              </div>
              {row.rejection_reason && <div style={{ fontSize: 11, color: 'var(--neg)', marginTop: 5 }}>{row.rejection_reason}</div>}
            </div>;
          })}

          {editing && <OCRRowEditor editing={editing} setField={setField} save={saveEdit} cancel={() => setEditing(null)} />}
          {['verified', 'ready_to_publish', 'published'].includes(item.status) && <OCRPublishPanel item={item} reload={load} setPage={setPage} />}
        </div>
      </div>
    </div>
  );
};

const OCRMarkdownReviewWorkspace = ({ item, review, setReview, reload, onBack }) => {
  const firstPage = review.pages[0]?.page || 1;
  const [selectedPage, setSelectedPage] = React.useState(firstPage);
  const [pageResult, setPageResult] = React.useState(null);
  const [pageLoading, setPageLoading] = React.useState(true);
  const [pageError, setPageError] = React.useState('');
  const [actionError, setActionError] = React.useState('');
  const [editing, setEditing] = React.useState(false);
  const [viewMode, setViewMode] = React.useState('preview');
  const [markdown, setMarkdown] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  const pageCount = review.pages.length || item.pages || 0;
  const locked = ['verified', 'published'].includes(review.status);
  const dirty = Boolean(editing && pageResult && markdown !== pageResult.effective_markdown);

  const loadPage = React.useCallback(async () => {
    setPageLoading(true);
    setPageError('');
    try {
      const result = await window.HelixAPI.ocrReviewPage(review.id, selectedPage);
      setPageResult(result);
      setMarkdown(result.effective_markdown || '');
      setEditing(false);
    } catch (error) {
      setPageResult(null);
      setPageError(error.message || 'Could not load this OCR page');
    } finally {
      setPageLoading(false);
    }
  }, [review.id, review.revision, selectedPage]);

  React.useEffect(() => { loadPage(); }, [loadPage]);
  React.useEffect(() => {
    if (!dirty) return undefined;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const confirmDiscard = async () => {
    if (!dirty) return true;
    return window.askConfirm({
      title: 'Discard Markdown changes?',
      message: 'Your unsaved changes to this OCR page will be lost.',
      confirmText: 'Discard',
      danger: true,
    });
  };

  const navigate = async nextPage => {
    if (nextPage === selectedPage || nextPage < 1 || nextPage > pageCount) return;
    if (!await confirmDiscard()) return;
    setActionError('');
    setSelectedPage(nextPage);
  };

  const leave = async () => {
    if (await confirmDiscard()) onBack();
  };

  const pageAction = async (action, correctedMarkdown = null) => {
    setSaving(true);
    setActionError('');
    try {
      const nextReview = await window.HelixAPI.ocrReviewPageAction(
        review.id,
        selectedPage,
        action,
        review.revision,
        correctedMarkdown,
      );
      setReview(nextReview);
      setEditing(false);
      if (action === 'correct') setViewMode('preview');
      window.toast?.(
        action === 'correct' ? `Page ${selectedPage} correction saved` : `Page ${selectedPage} ${action === 'restore' ? 'reset' : 'approved'}`,
        { type: 'success' },
      );
    } catch (error) {
      setActionError(error.message || `Could not ${action} page ${selectedPage}`);
      if (error.status === 409 || error.message?.includes('refresh')) await reload();
    } finally {
      setSaving(false);
    }
  };

  const saveCorrection = async () => {
    if (!editing) return;
    await pageAction('correct', markdown);
  };

  const verify = async () => {
    setSaving(true);
    setActionError('');
    try {
      const nextReview = await window.HelixAPI.ocrReviewVerify(review.id, review.revision);
      setReview(nextReview);
      await reload();
      window.toast?.('Page Markdown review verified', { type: 'success' });
    } catch (error) {
      setActionError(error.message || 'Could not verify the page review');
    } finally {
      setSaving(false);
    }
  };

  const selectedMeta = review.pages.find(page => page.page === selectedPage);
  const statusLabel = selectedMeta?.status || pageResult?.status || 'pending';

  return (
    <div className="page" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="page-header" style={{ marginBottom: 14 }}>
        <div>
          <button className="card-action" onClick={leave}>← OCR Inbox</button>
          <h1 className="page-title" style={{ marginTop: 8 }}>{item.filename}</h1>
          <p className="page-sub">
            {review.counts.resolved} of {review.counts.total} pages resolved · revision {review.revision}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <a className="btn" href={window.HelixAPI.ocrReviewMarkdownUrl(review.id, 'raw')} target="_blank" rel="noreferrer">Raw document</a>
          <a className="btn" href={window.HelixAPI.ocrReviewMarkdownUrl(review.id, 'effective')} target="_blank" rel="noreferrer">Reviewed document</a>
          <button className="btn btn-primary" disabled={saving || review.counts.pending > 0 || locked} onClick={verify}>Verify review</button>
        </div>
      </div>

      {actionError && <div role="alert" style={{ padding: '9px 12px', marginBottom: 10, border: '1px solid var(--neg)', borderRadius: 6, color: 'var(--neg)', fontSize: 12 }}>{actionError}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(420px,1.1fr) minmax(440px,1fr)', gap: 14, flex: 1, minHeight: 0 }}>
        <div className="card" style={{ minHeight: 0, display: 'flex', flexDirection: 'column', background: '#383b40' }}>
          <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, background: 'var(--bg-elev)', borderBottom: '1px solid var(--border)' }}>
            <button className="btn" disabled={selectedPage <= 1} onClick={() => navigate(selectedPage - 1)}>← Previous</button>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 7 }}>
              PDF page
              <select value={selectedPage} onChange={event => navigate(Number(event.target.value))} style={{ padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-elev)', color: 'var(--text)' }}>
                {review.pages.map(page => <option key={page.page} value={page.page}>{page.page} · {page.status}</option>)}
              </select>
              <span className="num">of {pageCount}</span>
            </label>
            <button className="btn" disabled={selectedPage >= pageCount} onClick={() => navigate(selectedPage + 1)}>Next →</button>
          </div>
          <div style={{ overflow: 'auto', padding: 12, flex: 1 }}>
            <div style={{ maxWidth: 850, margin: '0 auto' }}>
              <img
                src={window.HelixAPI.ocrInboxPageUrl(item.id, selectedPage)}
                alt={`Source PDF page ${selectedPage}`}
                style={{ width: '100%', height: 'auto', display: 'block', background: 'white' }}
              />
            </div>
          </div>
        </div>

        <div className="card" style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div className="card-header" style={{ gap: 12 }}>
            <div>
              <h3 className="card-title">Markdown · page {selectedPage}</h3>
              {pageResult && <div className="num" style={{ marginTop: 4, fontSize: 10, color: 'var(--text-muted)' }}>{fmtInboxBytes(pageResult.byte_size)} · {pageResult.content_sha256.slice(0, 12)}…</div>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {!editing && <div className="range-chips" role="tablist" aria-label="Markdown display mode">
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === 'preview'}
                  className={`range-chip ${viewMode === 'preview' ? 'active' : ''}`}
                  onClick={() => setViewMode('preview')}
                >Preview</button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === 'source'}
                  className={`range-chip ${viewMode === 'source' ? 'active' : ''}`}
                  onClick={() => setViewMode('source')}
                >Source</button>
              </div>}
              <InboxStatus status={statusLabel} />
            </div>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 14 }}>
            {pageLoading ? (
              <div style={{ display: 'grid', gap: 8 }} aria-label="Loading Markdown page">
                <div className="skeleton" style={{ height: 18, width: '65%' }} />
                <div className="skeleton" style={{ height: 12, width: '100%' }} />
                <div className="skeleton" style={{ height: 12, width: '92%' }} />
              </div>
            ) : pageError ? (
              <div role="alert" style={{ color: 'var(--neg)', fontSize: 12 }}>
                <div>{pageError}</div>
                <button className="btn" style={{ marginTop: 10 }} onClick={loadPage}>Retry</button>
              </div>
            ) : editing ? (
              <textarea
                value={markdown}
                onChange={event => setMarkdown(event.target.value)}
                aria-label={`Correct Markdown for page ${selectedPage}`}
                spellCheck="false"
                style={{ width: '100%', minHeight: '100%', resize: 'vertical', padding: 12, border: '1px solid var(--accent)', borderRadius: 6, background: 'var(--bg-sunken)', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.6 }}
              />
            ) : viewMode === 'preview' ? (
              <MarkdownPreview markdown={pageResult?.effective_markdown || ''} />
            ) : (
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.65, color: 'var(--text)' }}>{pageResult?.effective_markdown || 'This page contains no OCR text.'}</pre>
            )}
          </div>

          {!locked && !pageLoading && !pageError && <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 7, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            {editing ? <>
              <button className="btn" disabled={saving} onClick={() => { setMarkdown(pageResult?.effective_markdown || ''); setEditing(false); setViewMode('preview'); }}>Cancel</button>
              <button className="btn btn-primary" disabled={saving || !dirty} onClick={saveCorrection}>{saving ? 'Saving…' : 'Save correction'}</button>
            </> : <>
              {statusLabel === 'pending' && <button className="btn btn-primary" disabled={saving} onClick={() => pageAction('approve')}>Approve page</button>}
              <button className="btn" disabled={saving} onClick={() => { setMarkdown(pageResult?.effective_markdown || ''); setViewMode('source'); setEditing(true); }}>Edit Markdown</button>
              {statusLabel !== 'pending' && <button className="btn" disabled={saving} onClick={() => pageAction('restore')}>Reset to pending</button>}
            </>}
          </div>}
        </div>
      </div>
    </div>
  );
};

const OCRRowEditor = ({ editing, setField, save, cancel }) => {
  const fields = [['code', 'Code'], ['metric', 'Label'], ['section', 'Section'], ['curr', 'Current'], ['prev', 'Previous'], ['page', 'Page'], ['confidence', 'Confidence']];
  return <div style={{ margin: 14, padding: 14, border: '1px solid var(--accent)', borderRadius: 6, background: 'var(--bg-sunken)' }}>
    <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 10 }}>{editing.mode === 'manual' ? 'Add missing row' : 'Correct OCR row'}</div>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8 }}>
      {fields.map(([key, label]) => <label key={key} style={{ fontSize: 10, color: 'var(--text-muted)' }}>{label}<input value={editing.data[key] ?? ''} onChange={e => setField(key, e.target.value)} style={{ display: 'block', width: '100%', marginTop: 3, padding: '7px 8px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-elev)', color: 'var(--text)' }} /></label>)}
    </div>
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 10 }}><button className="btn" onClick={cancel}>Cancel</button><button className="btn btn-primary" onClick={save}>Save row</button></div>
  </div>;
};

const OCRPublishPanel = ({ item, reload, setPage }) => {
  const [labels, setLabels] = React.useState({ company: '', ticker: '', filing_type: 'BCTC', period: '', currency: 'VND', unit: 'million', ...(item.labels || {}) });
  const set = (key, value) => setLabels(x => ({ ...x, [key]: value }));
  const save = async () => { try { await window.HelixAPI.ocrInboxLabels(item.id, labels); await reload(); window.toast?.('Labels saved', { type: 'success' }); } catch (e) { window.toast?.(e.message, { type: 'error' }); } };
  const publish = async () => { try { await window.HelixAPI.ocrInboxPublish(item.id); await reload(); window.toast?.('Verified data published', { type: 'success' }); } catch (e) { window.toast?.(e.message, { type: 'error' }); } };
  if (item.status === 'published') return <div style={{ padding: 16 }}><button className="btn btn-primary" onClick={() => setPage('statements')}>Open published filing</button></div>;
  return <div style={{ padding: 16, borderTop: '2px solid var(--border)' }}>
    <div style={{ fontWeight: 700, marginBottom: 10 }}>Label before publication</div>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
      {Object.entries({ company: 'Company', ticker: 'Ticker', filing_type: 'Statement type', period: 'Period', currency: 'Currency', unit: 'Unit' }).map(([key, label]) => <label key={key} style={{ fontSize: 10, color: 'var(--text-muted)' }}>{label}<input value={labels[key] || ''} onChange={e => set(key, e.target.value)} style={{ display: 'block', width: '100%', marginTop: 3, padding: 7, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-elev)', color: 'var(--text)' }} /></label>)}
    </div>
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 7, marginTop: 12 }}><button className="btn" onClick={save}>Save labels</button><button className="btn btn-primary" disabled={item.status !== 'ready_to_publish'} onClick={publish}>Publish verified data</button></div>
  </div>;
};

window.PageOCRInbox = PageOCRInbox;
