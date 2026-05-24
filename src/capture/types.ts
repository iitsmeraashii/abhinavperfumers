export type CaptureMethod = 'BUSINESS_CARD' | 'QR' | 'MANUAL';

export type SessionStatus = 'IDLE' | 'CAPTURING' | 'DRAFT' | 'READY_FOR_REVIEW';

export type CardSide = 'front' | 'back';

export interface BusinessCardAsset {
  id: string;
  sessionId: string;
  side: CardSide;
  dataUrl: string;        // compressed image as data: URI
  mimeType: string;
  originalWidth: number;
  originalHeight: number;
  storedWidth: number;
  storedHeight: number;
  sizeBytes: number;
  createdAt: string;      // ISO string
}

export type OcrStatus = 'idle' | 'processing' | 'done' | 'error';

export interface OcrResult {
  assetId: string;
  rawText: string;
  fields: Partial<ManualEntryFields>;
  confidence: 'high' | 'medium' | 'low';
  inferredFields: string[];
  ignoredLines: string[];
  completedAt: string;
}

export interface DraftData {
  // Manual entry fields
  clientName?: string;
  company?: string;
  phone?: string;
  email?: string;
  designation?: string;
  notes?: string;
  // Business card assets (IDs reference IndexedDB 'assets' store)
  cardSessionId?: string;
  cardFrontAssetId?: string;
  cardBackAssetId?: string;
  // OCR results
  ocrRawText?: string;
  // QR scanner fields
  rawQr?: string;
  [key: string]: unknown;
}

export interface ManualEntryFields {
  clientName: string;
  company: string;
  phone: string;
  email: string;
  designation: string;
  notes: string;
}

export interface ManualEntryErrors {
  clientName?: string;
  company?: string;
  phone?: string;
}

export interface CaptureSession {
  captureMethod: CaptureMethod | null;
  sessionStatus: SessionStatus;
  createdAt: Date | null;
  updatedAt: Date | null;
  draftData: DraftData;
  hasUnsavedChanges: boolean;
}
