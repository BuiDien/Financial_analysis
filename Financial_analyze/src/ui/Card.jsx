// Card and Panel (tokens only — no Lucian card fits a data app). Render the legacy .card classes.
//
// <Card title="Holdings" subtitle? actions={<Button size="sm">Export</Button>} flush footer? overflow>
//   …body…
// </Card>
// flush: body without padding (tables). overflow: let popovers escape the card (no clipping).
// <Panel title?>…</Panel> — a flat sunken box for grouping inside a page or a card.

import React from 'react';
import { cx } from './util.js';
import './card.css';

const Card = React.forwardRef(({
  title, subtitle, actions, footer, flush = false, overflow = false, as: Tag = 'section', headingLevel = 3,
  className, bodyClassName, children, ...rest
}, ref) => {
  const H = `h${headingLevel}`;
  const hasHeader = title != null || actions != null;
  return (
    <Tag ref={ref} className={cx('card', overflow && 'is-overflow', className)} {...rest}>
      {hasHeader && (
        <div className="card-header">
          <div className="card-heading">
            {title != null && <H className="card-title">{title}</H>}
            {subtitle != null && <p className="card-subtitle">{subtitle}</p>}
          </div>
          {actions != null && <div className="card-actions">{actions}</div>}
        </div>
      )}
      {children != null && <div className={cx('card-body', flush && 'flush', bodyClassName)}>{children}</div>}
      {footer != null && <div className="card-footer">{footer}</div>}
    </Tag>
  );
});
Card.displayName = 'Card';

const Panel = ({ title, className, children, ...rest }) => (
  <div className={cx('panel', className)} {...rest}>
    {title != null && <h4 className="panel-title">{title}</h4>}
    {children}
  </div>
);

export { Card, Panel };
