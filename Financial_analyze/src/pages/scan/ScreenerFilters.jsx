// Screener left panel: the rules funnel. Strategy picker, Simple ("How picky?" + plain checks)
// or Advanced (scope + every rule with its numbers), and the save / reset actions.
// Collapsible: starts closed on narrow screens.

import React from 'react';
import * as SP from './screener-plain.js';
import { Badge, Button, Segmented, Select, Switch } from '../../ui/index.js';
import { SCR_BANK_OPTS, SCR_EXCHANGES, SCR_OVER, SCR_STAGES, scrNormalize } from './screener-model.js';
import { ScrPlainRule, ScrRuleRow } from './ScreenerRules.jsx';

const ADV_KEY = 'scr-advanced';
const readAdvanced = () => { try { return localStorage.getItem(ADV_KEY) === '1'; } catch (e) { return false; } };

const StrategyPicker = ({ s }) => {
  const chip = (st) => (
    <button key={st.id} type="button" className="scan-chip" aria-pressed={st.id === s.activeId}
      onClick={() => s.selectStrategy(st)} data-tip={SP.STRATEGY_DESC[st.starter_key] || 'Your own strategy'}>{st.name}</button>
  );
  return (
    <div className="scan-sect">
      <div className="scan-label">Strategy</div>
      <div className="scan-chips">
        {s.strategies.filter(st => st.starter_key).map(chip)}
        {s.strategies.filter(st => !st.starter_key).map(chip)}
        <button type="button" className="scan-chip is-new" onClick={s.saveAsNew}>+ My own</button>
      </div>
      {s.active && <p className="scan-desc"><b>{s.active.name}:</b> {SP.STRATEGY_DESC[s.active.starter_key] || 'Your own strategy'}</p>}
    </div>
  );
};

const StrategyActions = ({ s }) => {
  if (!s.dirty && !s.active) return null;
  return (
    <div className="scan-actions">
      {s.dirty && <Badge tone="accent" dot>Modified</Badge>}
      {s.dirty && <Button size="sm" variant="primary" onClick={s.save}>Save</Button>}
      {s.dirty && <Button size="sm" onClick={s.saveAsNew}>Save as new</Button>}
      {s.dirty && <Button size="sm" variant="ghost" onClick={s.discard}>Discard</Button>}
      {s.isStarter && <Button size="sm" variant="ghost" onClick={s.resetStarter}>Reset to default</Button>}
      {s.active && !s.isStarter && <Button size="sm" variant="ghost" onClick={s.rename}>Rename</Button>}
      {s.active && !s.isStarter && <Button size="sm" variant="danger" onClick={s.remove}>Delete</Button>}
    </div>
  );
};

const SimpleRules = ({ s, ruleCfg, visible, scopeCfg }) => {
  const levels = SP.LEVELS.map(id => ({ value: id, label: SP.LEVEL_LABEL[id] }));
  if (s.level === 'custom') levels.push({ value: 'custom', label: SP.LEVEL_LABEL.custom });
  const goodOn = Object.values(s.catalog).filter(sp => sp.stage === 'good' && visible(sp) && (ruleCfg(sp.id) || {}).on);
  const overOn = SCR_OVER.filter(id => (ruleCfg(id) || {}).on);
  return (
    <>
      <div className="scan-sect">
        <div className="scan-label">How picky?</div>
        <Segmented ariaLabel="How picky" size="sm" value={s.level} onChange={s.setLevel} options={levels} />
        <p className="scan-hint">
          Easy shows more stocks, Strict shows only the best.{s.level === 'custom' ? ' You changed numbers in Advanced.' : ''} {SP.scopeSummary(scopeCfg)}.
        </p>
      </div>
      <div className="scan-group">
        <div className="scan-label">A stock must pass every check</div>
        {goodOn.map(sp => <ScrPlainRule key={sp.id} id={sp.id} cfg={ruleCfg(sp.id)} />)}
        {!goodOn.length && <p className="scan-hint">No checks are on. Switch to Advanced to turn some on.</p>}
      </div>
      {overOn.length > 0 && (
        <div className="scan-group">
          <div className="scan-label">⚡ Bounce signal: marks passing stocks whose price just dropped hard</div>
          {overOn.map(id => <ScrPlainRule key={id} id={id} cfg={ruleCfg(id)} />)}
        </div>
      )}
    </>
  );
};

const AdvancedRules = ({ s, visible, scopeCfg }) => {
  const { catalog, rules, editRule } = s;
  const banks = scopeCfg ? scopeCfg.banks : 'any';
  const exchanges = (scopeCfg && scopeCfg.exchanges) || [];
  const flagged = scopeCfg ? (scopeCfg.flagged || 'exclude') : 'exclude';
  const norm = scrNormalize(catalog, rules);
  const bankOpts = Object.entries(SCR_BANK_OPTS).filter(([k]) => catalog.scope.params.banks.options.includes(k)).map(([value, label]) => ({ value, label }));
  return (
    <>
      <div className="scan-sect">
        <Select label="Scope · banks" size="sm" value={banks} onChange={(v) => editRule('scope', { banks: v })} options={bankOpts} />
        {catalog.scope.params.exchanges && (
          <div>
            <div className="scan-label" data-tip="None selected = all exchanges">Scope · exchanges</div>
            <div className="scan-chips">
              {SCR_EXCHANGES.map(ex => {
                const on = exchanges.includes(ex);
                return (
                  <button key={ex} type="button" className="scan-chip is-sm" aria-pressed={on}
                    onClick={() => editRule('scope', { exchanges: on ? exchanges.filter(e => e !== ex) : [...exchanges, ex] })}>{ex}</button>
                );
              })}
              {exchanges.length === 0 && <span className="scan-hint">all</span>}
            </div>
          </div>
        )}
        {catalog.scope.params.flagged && (
          <Switch checked={flagged === 'exclude'} labelPosition="end"
            label="Hide warned / controlled stocks" description="Exchange warning, control, restriction or suspension"
            onChange={(on) => editRule('scope', { flagged: on ? 'exclude' : 'include' })} />
        )}
      </div>
      {SCR_STAGES.map(stage => (
        <div key={stage.id} className="scan-group">
          <div className="scan-label">{stage.title}</div>
          {Object.values(catalog).filter(sp => sp.stage === stage.id && visible(sp)).map(sp => {
            const cfg = norm.find(c => c.id === sp.id);
            const raw = rules.find(r => r.id === sp.id);
            const shownCfg = raw ? { ...cfg, ...Object.fromEntries(Object.keys(sp.params).map(k => [k, raw[k]])) } : cfg;
            return <ScrRuleRow key={sp.id} spec={sp} cfg={shownCfg} onChange={(patch) => editRule(sp.id, patch)} />;
          })}
        </div>
      ))}
    </>
  );
};

const ScreenerFilters = ({ s }) => {
  const [open, setOpen] = React.useState(() => !(typeof window !== 'undefined' && window.matchMedia?.('(max-width: 900px)').matches));
  const [advanced, setAdvancedState] = React.useState(readAdvanced);
  const setAdvanced = (v) => { setAdvancedState(v); try { localStorage.setItem(ADV_KEY, v ? '1' : '0'); } catch (e) { /* ignore */ } };
  const bodyId = 'scan-filters-body';

  const { catalog, rules } = s;
  const norm = scrNormalize(catalog, rules);
  const ruleCfg = (id) => norm.find(c => c.id === id) || null;
  const scopeCfg = ruleCfg('scope');
  const banks = scopeCfg ? scopeCfg.banks : 'any';
  const visible = (spec) => !(spec.applies_to === 'bank' && (banks === 'exclude' || banks === 'no_financials')) && !(spec.applies_to === 'nonbank' && banks === 'only');
  const activeCount = Object.values(catalog).filter(sp => sp.id !== 'scope' && visible(sp) && (ruleCfg(sp.id) || {}).on).length;

  return (
    <aside className={`card scan-filters${open ? '' : ' is-closed'}`} aria-label="Screener rules">
      <div className="card-header scan-filters-head">
        <button type="button" className="scan-filters-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
          <span className="card-title">Rules{s.active ? ` · ${s.active.name}` : ''}</span>
          <Badge tone="neutral">{activeCount} on</Badge>
          {s.dirty && <Badge tone="accent">Modified</Badge>}
          <span className="scan-caret" aria-hidden="true">{open ? '▴' : '▾'}</span>
        </button>
      </div>
      {open && (
        <div id={bodyId} className="scan-filters-body">
          <StrategyPicker s={s} />
          <StrategyActions s={s} />
          <div className="scan-sect">
            <Segmented ariaLabel="Rules view" size="sm" value={advanced ? 'adv' : 'simple'} onChange={(v) => setAdvanced(v === 'adv')}
              options={[{ value: 'simple', label: 'What we look for' }, { value: 'adv', label: 'Advanced' }]} />
          </div>
          {advanced
            ? <AdvancedRules s={s} visible={visible} scopeCfg={scopeCfg} />
            : <SimpleRules s={s} ruleCfg={ruleCfg} visible={visible} scopeCfg={scopeCfg} />}
        </div>
      )}
      {!open && s.active && <p className="scan-hint scan-closed-sum">{activeCount} checks · {SP.LEVEL_LABEL[s.level] || s.level}</p>}
    </aside>
  );
};

export { ScreenerFilters };
