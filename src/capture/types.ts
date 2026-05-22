export type CaptureMethod = 'BUSINESS_CARD' | 'QR' | 'MANUAL';

export type SessionStatus = 'IDLE' | 'CAPTURING' | 'DRAFT' | 'READY_FOR_REVIEW';

export interface DraftData {
  // Manual entry fields
  clientName?: string;
  company?: string;
  phone?: string;
  email?: string;
  designation?: string;
  notes?: string;
  // Scanner fields (future)
  rawImageFront?: string;
  rawImageBack?: string;
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
