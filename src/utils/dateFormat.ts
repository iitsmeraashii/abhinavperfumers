// Shared date/time formatting utilities.
//
// All functions resolve the user's browser timezone at call time via
// Intl.DateTimeFormat().resolvedOptions().timeZone — no hardcoded timezone.
// This means a rep in Mumbai sees IST, a rep in Dubai sees GST, etc.
//
// Convention:
//   formatDateTime  — "07 Jul 2026, 02:35 PM"   (date + time, used for DB timestamps)
//   formatDate      — "07 Jul 2026"              (date only, used for event dates / follow-up dates)
//   formatTime      — "02:35 PM"                 (time only, used for intra-day displays)
//   formatDateLong  — "7 July 2026"              (long form, used in detail cards)

function localTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Full date + time in the user's local timezone.
 * Suitable for DB timestamps (created_at, updated_at, attempt times, etc.)
 * Returns null for falsy input.
 */
export function formatDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: localTz(),
  });
}

/**
 * Date + time with seconds, for notification/log displays.
 */
export function formatDateTimeWithSeconds(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
    timeZone: localTz(),
  });
}

/**
 * Date only (no time). Safe to call with a plain date string like "2026-07-07"
 * — appends T00:00:00 so it isn't misinterpreted as UTC midnight.
 */
export function formatDate(d: string | null | undefined): string | null {
  if (!d) return null;
  // If the value is already a full ISO timestamp, use it directly.
  // If it's a plain date string (YYYY-MM-DD), anchor at local midnight.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00` : d;
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    timeZone: localTz(),
  });
}

/**
 * Long-form date: "7 July 2026". Used in detail cards / account page.
 */
export function formatDateLong(d: string | null | undefined): string | null {
  if (!d) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00` : d;
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric',
    timeZone: localTz(),
  });
}

/**
 * Short date: "7 Jul 2026" (numeric day). Used in dropdowns / compact displays.
 */
export function formatDateShort(d: string | null | undefined): string | null {
  if (!d) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00` : d;
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
    timeZone: localTz(),
  });
}

/**
 * Time only — HH:MM:SS. Used in the capture placeholder session start time.
 */
export function formatTimeWithSeconds(date: Date): string {
  return date.toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: localTz(),
  });
}

/**
 * Current local time as a formatted string — for CSV export headers etc.
 */
export function nowFormatted(): string {
  return new Date().toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
    timeZone: localTz(),
  });
}
