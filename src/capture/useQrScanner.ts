// Thin React wrapper around html5-qrcode.
// Keeps all scanner lifecycle logic out of UI components.

import { useState, useRef, useCallback, useEffect } from 'react';
import { Html5Qrcode, Html5QrcodeScanType } from 'html5-qrcode';
import type { ParsedContact } from './parseQrPayload';
import { parseQrPayload } from './parseQrPayload';

export type ScannerState =
  | 'idle'
  | 'requesting'   // asking for camera permission
  | 'scanning'     // camera active, scanning frames
  | 'success'      // QR decoded
  | 'error';       // unrecoverable error

export interface UseQrScannerReturn {
  state: ScannerState;
  error: string | null;
  result: ParsedContact | null;
  startScanner: (elementId: string) => Promise<void>;
  stopScanner: () => Promise<void>;
}

// 200×200 scan box = fewer pixels per frame = faster decode on mobile.
// videoConstraints requests 720p rear camera for fast init at sufficient quality.
const SCANNER_CONFIG = {
  fps: 15,
  qrbox: { width: 200, height: 200 },
  aspectRatio: 1.0,
  supportedScanTypes: [Html5QrcodeScanType.SCAN_TYPE_CAMERA],
  showTorchButtonIfSupported: false,
  showZoomSliderIfSupported: false,
  defaultZoomValueIfSupported: 1,
  videoConstraints: {
    facingMode: { ideal: 'environment' },
    width:  { ideal: 1280 },
    height: { ideal: 720 },
  },
} as const;

export function useQrScanner(): UseQrScannerReturn {
  const [state, setState] = useState<ScannerState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ParsedContact | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const mountedRef = useRef(true);
  // Guards against the success callback firing more than once per session
  const resolvedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const stopScanner = useCallback(async () => {
    const scanner = scannerRef.current;
    if (!scanner) return;
    // Null the ref immediately so no re-entrant calls operate on a stale instance
    scannerRef.current = null;
    try {
      if (scanner.isScanning) await scanner.stop();
      scanner.clear();
    } catch {
      // Ignore — element may already be torn down
    }
    if (mountedRef.current) {
      setState(prev => (prev === 'scanning' || prev === 'requesting' ? 'idle' : prev));
    }
  }, []);

  const startScanner = useCallback(async (elementId: string) => {
    await stopScanner();
    if (!mountedRef.current) return;

    resolvedRef.current = false;
    setState('requesting');
    setError(null);
    setResult(null);

    try {
      const scanner = new Html5Qrcode(elementId, { verbose: false });
      scannerRef.current = scanner;

      const cameras = await Html5Qrcode.getCameras();
      if (!mountedRef.current) { scanner.clear(); return; }

      if (!cameras || cameras.length === 0) {
        throw new Error('No camera found on this device.');
      }

      // Prefer rear camera by label; fall back to last listed camera
      const rearCamera =
        cameras.find(c => /back|rear|environment/i.test(c.label)) ??
        cameras[cameras.length - 1];

      if (!mountedRef.current) { scanner.clear(); return; }
      setState('scanning');

      await scanner.start(
        { deviceId: rearCamera.id },
        SCANNER_CONFIG,
        // ── Success callback ────────────────────────────────────────────
        // Null the ref and stop camera FIRST so no further frames are processed.
        // Parse only after the camera is already being torn down.
        (decodedText) => {
          if (!mountedRef.current || resolvedRef.current) return;
          resolvedRef.current = true;

          // Grab and clear the ref synchronously before any async work
          const activeScanner = scannerRef.current;
          scannerRef.current = null;

          const parsed = parseQrPayload(decodedText);

          if (mountedRef.current) {
            setResult(parsed);
            setState('success');
          }

          // Stop camera asynchronously after UI has already transitioned
          if (activeScanner) {
            (async () => {
              try {
                if (activeScanner.isScanning) await activeScanner.stop();
                activeScanner.clear();
              } catch { /* ignore */ }
            })();
          }
        },
        // Frame error callback — fires on every non-QR frame; suppress entirely
        () => undefined,
      );
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      scannerRef.current = null;

      const msg = err instanceof Error ? err.message : String(err);
      if (/permission|notallowed|denied/i.test(msg)) {
        setError('Camera access was denied. Please allow camera permission in your browser settings and try again.');
      } else if (/notfound|device/i.test(msg)) {
        setError('No camera found. Connect a camera and try again.');
      } else {
        setError(msg || 'Camera could not be started. Please try again.');
      }
      setState('error');
    }
  }, [stopScanner]);

  return { state, error, result, startScanner, stopScanner };
}
