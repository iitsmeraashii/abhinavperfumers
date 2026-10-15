import { WHATSAPP_STATUS_OPTIONS } from './whatsappStatusFilter';

export function parseWhatsAppCounts(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result: Record<string, number> = {};
  for (const { value: key } of WHATSAPP_STATUS_OPTIONS) {
    const count = (value as Record<string, unknown>)[key];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return null;
    result[key] = count;
  }
  return result;
}
