import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import App from './App';
import { SipProvider } from './contexts/SipContext';
import { applyTheme, watchSystemTheme } from './lib/userPrefs';
import './styles.css';

// Apply theme BEFORE first render so there's no light/dark flash.
applyTheme();
watchSystemTheme();

// Choose router based on protocol: Electron loads from file:// where
// BrowserRouter's path-based URLs break (e.g. /login resolves to
// file:///C:/login). HashRouter uses #/login which works under any origin.
// Web browsers (https://) keep BrowserRouter for clean URLs.
const Router = window.location.protocol === 'file:' ? HashRouter : BrowserRouter;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Router>
      <SipProvider>
        <App />
      </SipProvider>
    </Router>
  </React.StrictMode>
);
