export type CaptureMethod = 'BUSINESS_CARD' | 'QR' | 'MANUAL';

export type SessionStatus = 'IDLE' | 'CAPTURING' | 'DRAFT' | 'READY_FOR_REVIEW';

export interface DraftData {
  clientName?: string;
  company?: string;
  phone?: string;
  email?: string;
  notes?: string;
  rawImageFront?: string;
  rawImageBack?: string;
  rawQr?: string;
  [key: string]: unknown;
}

export interface CaptureSession {
  captureMethod: CaptureMethod | null;
  sessionStatus: SessionStatus;
  createdAt: Date | null;
  updatedAt: Date | null;
  draftData: DraftData;
  hasUnsavedChanges: boolean;
}
