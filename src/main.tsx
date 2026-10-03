import { bootstrapNativeConnectivity } from './mobile/nativeConnectivity';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { init, startRealtime } from './runtime/runtimeDiagnostics';

bootstrapNativeConnectivity();

init().catch(() => {});
startRealtime();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
