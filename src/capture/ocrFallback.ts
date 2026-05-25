// Minimal Tesseract fallback — no React, no hooks.
// Called only when OpenAI Vision is unavailable.

const TESSERACT_ESM_URL    = '/tesseract.esm.min.js';
const TESSERACT_WORKER_URL = '/tesseract.worker.min.js';
const TIMEOUT_MS           = 20_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let workerSingleton: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getWorker(): Promise<any> {
  if (workerSingleton) return workerSingleton;

  const mod = await import(/* @vite-ignore */ TESSERACT_ESM_URL);
  const createWorker = mod.createWorker ?? mod.default?.createWorker;
  if (typeof createWorker !== 'function') throw new Error('Tesseract ESM: createWorker not found');

  workerSingleton = await createWorker('eng', 1, {
    workerPath: TESSERACT_WORKER_URL,
    logger: () => { /* silent */ },
  });
  return workerSingleton;
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, b64] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)?.[1] ?? 'image/jpeg';
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

export default async function runOcrDirect(dataUrl: string): Promise<string> {
  const blob    = dataUrlToBlob(dataUrl);
  const objUrl  = URL.createObjectURL(blob);

  try {
    const worker  = await getWorker();
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Tesseract timeout after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await Promise.race([worker.recognize(objUrl), timeout]);
    return result?.data?.text ?? '';
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}
