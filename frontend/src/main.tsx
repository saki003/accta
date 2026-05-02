import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initCornerstone } from './lib/cornerstoneInit';
import { registerAcctaImageLoader } from './lib/acctaImageLoader';
import './index.css';

async function bootstrap(): Promise<void> {
  await initCornerstone();
  registerAcctaImageLoader();

  const rootEl = document.getElementById('root');
  if (!rootEl) {
    throw new Error('Root element #root not found in the DOM.');
  }

  ReactDOM.createRoot(rootEl).render(
    <App />,
  );
}

bootstrap().catch((err: unknown) => {
  console.error('Failed to initialise accta viewer:', err);
});
