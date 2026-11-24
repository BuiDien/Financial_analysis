// Settings sections: General, Appearance, Data & Display.

import React from 'react';
import { Segmented, Select, Switch } from '../../ui';
import { CURRENCIES, LANDING_PAGES } from './settings-store.js';
import { SettingRow, SettingsCard, SettingsSection } from './SettingsParts.jsx';

const CURRENCY_OPTIONS = CURRENCIES.map(c => ({ value: c, label: c }));
const LANDING_OPTIONS = LANDING_PAGES.map(p => ({ value: p.id, label: p.label }));
const DENSITY_OPTIONS = [{ value: 'compact', label: 'Compact' }, { value: 'normal', label: 'Normal' }, { value: 'comfortable', label: 'Comfortable' }];
const THEMES = [
  { id: 'light', label: 'Light', hint: 'Bright & clean' },
  { id: 'dark', label: 'Dark', hint: 'Easy on the eyes' },
];

export const GeneralSection = ({ settings, onBaseCurrency }) => (
  <SettingsSection id="account" title="General" subtitle="Portfolio defaults">
    <SettingsCard>
      <SettingRow label="Base currency" hint="Portfolio display currency — native records are unchanged">
        <Select size="sm" ariaLabel="Base currency" value={settings.baseCurrency} options={CURRENCY_OPTIONS} onChange={onBaseCurrency} />
      </SettingRow>
    </SettingsCard>
  </SettingsSection>
);

export const AppearanceSection = ({ theme, setTheme, accent, setAccent, accents, density, setDensity }) => (
  <SettingsSection id="appearance" title="Appearance" subtitle="Theme, accent colour and density">
    <SettingsCard>
      <SettingRow label="Theme" hint="Light or dark interface" stacked>
        <div className="set-themes" role="radiogroup" aria-label="Theme">
          {THEMES.map(t => (
            <button key={t.id} type="button" role="radio" aria-checked={theme === t.id}
              className={`set-theme is-${t.id}${theme === t.id ? ' is-on' : ''}`} onClick={() => setTheme(t.id)}>
              <span className="set-theme-name">{t.label}</span>
              <span className="set-theme-hint">{t.hint}</span>
              <span className="set-theme-swatches" aria-hidden="true"><i /><i /><i /></span>
            </button>
          ))}
        </div>
      </SettingRow>
      <SettingRow label="Accent color" hint="Highlights, links, and primary actions" stacked>
        <div className="set-accents" role="radiogroup" aria-label="Accent color">
          {accents.map(a => (
            <button key={a.id} type="button" role="radio" aria-checked={accent === a.id} title={a.label}
              className={`set-accent${accent === a.id ? ' is-on' : ''}`} onClick={() => setAccent(a.id)}>
              <span className="set-accent-sw" style={{ background: a.id }} aria-hidden="true" />
              {a.label}
            </button>
          ))}
        </div>
      </SettingRow>
      <SettingRow label="Density" hint="Spacing in tables and lists">
        <Segmented size="sm" ariaLabel="Density" value={density} options={DENSITY_OPTIONS} onChange={setDensity} />
      </SettingRow>
    </SettingsCard>
  </SettingsSection>
);

export const DisplaySection = ({ settings, set }) => (
  <SettingsSection id="display" title="Data & Display" subtitle="Default views and chrome">
    <SettingsCard>
      <SettingRow label="Landing page" hint="Where Helix opens on launch">
        <Select size="sm" ariaLabel="Landing page" value={settings.defaultLanding} options={LANDING_OPTIONS} onChange={v => set('defaultLanding', v)} />
      </SettingRow>
      <SettingRow label="Ticker tape in header" hint="Scrolling index prices at the top">
        <Switch aria-label="Ticker tape in header" checked={!!settings.tickerTape} onChange={v => set('tickerTape', v)} />
      </SettingRow>
    </SettingsCard>
  </SettingsSection>
);
