// Entry point. Styles first (fonts, theme tokens/base styles, then the src/ui
// component library with its --ux-* tokens); everything else is reached through
// app.jsx's imports (pages live in src/pages/**).
import './styles/fonts/fonts.css';
import './styles/app.css';
import './ui/index.js';

import { createRoot } from 'react-dom/client';
import { App } from './app.jsx';

createRoot(document.getElementById('root')).render(<App />);
