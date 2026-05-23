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

const SCANNER_CONFIG = {
  fps: 10,
  qrbox: { width: 250, height: 250 },
  aspectRatio: 1.0,
  supportedScanTypes: [Html5QrcodeScanType.SCAN_TYPE_CAMERA],
  showTorchButtonIfSupported: false,
  showZoomSliderIfSupported: false,
  defaultZoomValueIfSupported: 1,
} as const;

export function useQrScanner(): UseQrScannerReturn {
  const [state, setState] = useState<ScannerState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ParsedContact | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const stopScanner = useCallback(async () => {
    const scanner = scannerRef.current;
    if (!scanner) return;
    try {
      const isRunning = scanner.isScanning;
      if (isRunning) await scanner.stop();
      scanner.clear();
    } catch {
      // Ignore stop errors — element may already be cleared
    }
    scannerRef.current = null;
    if (mountedRef.current) {
      setState(prev => (prev === 'scanning' || prev === 'requesting' ? 'idle' : prev));
    }
  }, []);

  const startScanner = useCallback(async (elementId: string) => {
    // Clean up any previous instance
    await stopScanner();

    if (!mountedRef.current) return;
    setState('requesting');
    setError(null);
    setResult(null);

    try {
      const scanner = new Html5Qrcode(elementId, { verbose: false });
      scannerRef.current = scanner;

      // Prefer rear camera on mobile
      const cameras = await Html5Qrcode.getCameras();
      if (!mountedRef.current) { scanner.clear(); return; }

      if (!cameras || cameras.length === 0) {
        throw new Error('No camera found on this device.');
      }

      // Pick rear camera: prefer one labelled "back" / "environment"
      const rearCamera =
        cameras.find(c => /back|rear|environment/i.test(c.label)) ??
        cameras[cameras.length - 1];

      if (!mountedRef.current) { scanner.clear(); return; }
      setState('scanning');

      await scanner.start(
        rearCamera.id,
        SCANNER_CONFIG,
        // Success callback
        (decodedText) => {
          if (!mountedRef.current) return;
          const parsed = parseQrPayload(decodedText);
          setResult(parsed);
          setState('success');
          // Stop scanning after first successful decode
          stopScanner();
        },
        // Frame error callback — suppress; fires every non-QR frame
        () => undefined,
      );
    } catch (err: unknown) {
      if (!mountedRef.current) return;

      const msg = err instanceof Error ? err.message : String(err);

      // Detect camera permission denial
      if (/permission|notallowed|denied/i.test(msg)) {
        setError('Camera access was denied. Please allow camera permission in your browser settings and try again.');
      } else if (/notfound|device/i.test(msg)) {
        setError('No camera found. Connect a camera and try again.');
      } else {
        setError(msg || 'Camera could not be started. Please try again.');
      }

      setState('error');
      scannerRef.current = null;
    }
  }, [stopScanner]);

  return { state, error, result, startScanner, stopScanner };
}
