// Building blocks for the Settings page: a section (anchor target + Card), a labelled
// setting row (label/hint left, control right) and a tinted status note.

import React from 'react';
import { Card, cx } from '../../ui';

export const SettingsSection = ({ id, title, subtitle, children }) => (
  <section id={`set-${id}`} className="set-section" data-section={id} aria-labelledby={`set-${id}-h`}>
    <h2 id={`set-${id}-h`} className="set-section-title">{title}</h2>
    {subtitle && <p className="set-section-sub">{subtitle}</p>}
    <div className="stack">{children}</div>
  </section>
);

export const SettingsCard = ({ title, subtitle, actions, children }) => (
  <Card title={title} subtitle={subtitle} actions={actions} bodyClassName="set-card-body">{children}</Card>
);

// stacked: control goes under the label (wide controls such as theme cards).
export const SettingRow = ({ label, hint, children, stacked = false, htmlFor }) => (
  <div className={cx('set-row', stacked && 'is-stacked')}>
    <div className="set-row-text">
      {htmlFor ? <label className="set-row-label" htmlFor={htmlFor}>{label}</label> : <div className="set-row-label">{label}</div>}
      {hint && <div className="set-row-hint">{hint}</div>}
    </div>
    <div className="set-row-control">{children}</div>
  </div>
);

// tone: pos | neg | neutral
export const StatusNote = ({ tone = 'neutral', title, children }) => (
  <div className={cx('set-note', `is-${tone}`)} role="status">
    {title && (
      <div className="set-note-title"><span className="set-note-dot" aria-hidden="true" />{title}</div>
    )}
    {children && <div className="set-note-body">{children}</div>}
  </div>
);
