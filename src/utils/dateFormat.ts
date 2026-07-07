// Shared date/time formatting utilities.
//
// All functions resolve the user's browser timezone at call time via
// Intl.DateTimeFormat().resolvedOptions().timeZone — no hardcoded timezone.
//
// IMPORTANT — UTC normalisation:
// Supabase PostgREST returns `timestamp` (without time zone) columns as bare
// ISO strings like "2026-07-07T08:51:24.913" with NO timezone suffix.
// JavaScript's Date constructor treats bare ISO strings as LOCAL time, which
// means new Date("2026-07-07T08:51:24.913") in IST gives 08:51 IST — wrong.
// The correct interpretation is UTC (Postgres stores all timestamps in UTC).
// toUtc() appends "Z" when no timezone offset is present, forcing UTC parse.

function toUtc(iso: string): string {
  // Already has a timezone indicator — leave it alone.
  if (/[Zz]$/.test(iso) || /[+-]\d{2}:\d{2}$/.test(iso) || /[+-]\d{4}$/.test(iso)) {
    return iso;
  }
  // Replace the space separator Postgres sometimes uses, then append Z.
  return iso.replace(' ', 'T') + 'Z';
}

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
  return new Date(toUtc(iso)).toLocaleString('en-IN', {
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
  return new Date(toUtc(iso)).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
    timeZone: localTz(),
  });
}

/**
 * Date only (no time). Safe to call with a plain date string like "2026-07-07"
 * — plain date strings are treated as UTC midnight (no Z appended) to avoid
 * timezone-day-shift on YYYY-MM-DD values that represent calendar dates.
 */
export function formatDate(d: string | null | undefined): string | null {
  if (!d) return null;
  // Plain date-only string: interpret as a calendar date in the user's local TZ.
  // Appending T00:00:00 (no Z) makes JS parse it as local midnight, which is
  // correct for event dates, follow-up dates, etc. that have no time component.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00` : toUtc(d);
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
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00` : toUtc(d);
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
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00` : toUtc(d);
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
