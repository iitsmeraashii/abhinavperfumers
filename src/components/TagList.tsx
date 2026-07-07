interface TagListProps {
  values: string[];
  emptyText?: string;
}

/**
 * Read-only chip display for string-array fields.
 * Renders each value as a small pill badge. Falls back to emptyText when empty.
 */
export function TagList({ values, emptyText = '—' }: TagListProps) {
  if (!values || values.length === 0) {
    return <span className="text-sm text-stone-300">{emptyText}</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map(tag => (
        <span
          key={tag}
          className="inline-flex items-center px-2 py-0.5 rounded-md bg-stone-100 text-xs font-medium text-stone-700"
        >
          {tag}
        </span>
      ))}
    </div>
  );
}

/**
 * Parse a database text value that may be:
 *  - A JSON array string:    '["Luxury","Mass Market"]'
 *  - A comma-separated list: 'Luxury,Mass Market'
 *  - A plain string:         'Luxury'
 *  - null / empty
 */
export function parseTagString(s: string | null | undefined): string[] {
  if (!s) return [];
  const trimmed = s.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
      }
    } catch { /* fall through to comma split */ }
  }
  return trimmed.split(',').map(t => t.trim()).filter(Boolean);
}

/**
 * Serialize a string[] back to a JSON text value for DB storage.
 * Returns null when the array is empty.
 */
export function serializeTagArray(tags: string[]): string | null {
  if (!tags || tags.length === 0) return null;
  return JSON.stringify(tags);
}
