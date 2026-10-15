// Values are exact stored outreach states; Not set means SQL NULL only.
export const WHATSAPP_STATUS_OPTIONS = [
  { value: 'READ', label: 'Read' },
  { value: 'DELIVERED', label: 'Delivered' },
  { value: 'SENT', label: 'Sent' },
  { value: 'ACCEPTED', label: 'Accepted' },
  { value: 'processing', label: 'Processing' },
  { value: 'RETRY', label: 'Retry' },
  { value: 'FAILED', label: 'Failed' },
  { value: '__not_set__', label: 'Not set' },
] as const;

export function normalizeWhatsAppStatuses(values: readonly string[]): string[] {
  return WHATSAPP_STATUS_OPTIONS.filter(option => values.includes(option.value)).map(option => option.value);
}

// PostgREST's builder replaces earlier .or() calls. Combine nullable filters
// into one expression so adding WhatsApp statuses cannot erase another filter.
export function buildLeadFilterOr(filters: {
  whatsappStatuses: string[];
  temperature: string;
  state: string;
  country: string;
}): string | null {
  const groups: string[] = [];
  for (const [column, value] of [
    ['lead_temperature', filters.temperature], ['state', filters.state], ['country', filters.country],
  ]) {
    if (value === '__unassigned__') groups.push(`or(${column}.is.null,${column}.eq.)`);
  }
  const statuses = normalizeWhatsAppStatuses(filters.whatsappStatuses);
  if (statuses.length) {
    groups.push(`or(${statuses.map(value => value === '__not_set__'
      ? 'whatsapp_status.is.null' : `whatsapp_status.eq.${value}`).join(',')})`);
  }
  return groups.length ? `and(${groups.join(',')})` : null;
}
