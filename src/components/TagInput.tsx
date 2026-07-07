import { useRef, useState } from 'react';
import { X, Plus } from 'lucide-react';

interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}

/**
 * Inline tag-bag input. Commits a pending tag on:
 *   Enter, Comma, Tab  — keyboard shortcuts
 *   Blur               — clicking away / tabbing out
 *   + button click     — explicit add
 *
 * Deduplication is case-insensitive. Empty/whitespace values are ignored.
 * Backspace on empty input removes the last tag.
 */
export function TagInput({ value, onChange, placeholder = 'Add…' }: TagInputProps) {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  function commit(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) { setInput(''); return; }
    if (value.some(t => t.toLowerCase() === trimmed.toLowerCase())) { setInput(''); return; }
    onChange([...value, trimmed]);
    setInput('');
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit(input);
    } else if (e.key === 'Tab') {
      if (input.trim()) {
        e.preventDefault();
        commit(input);
      }
    } else if (e.key === 'Backspace' && input === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  function remove(tag: string) {
    onChange(value.filter(t => t !== tag));
  }

  return (
    <div
      className="min-h-[38px] flex flex-wrap gap-1.5 items-center px-2.5 py-1.5 border border-stone-200 rounded-lg bg-white cursor-text transition focus-within:ring-2 focus-within:ring-amber-500 focus-within:border-transparent"
      onClick={() => inputRef.current?.focus()}
    >
      {value.map(tag => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-stone-100 text-xs font-medium text-stone-700 select-none"
        >
          {tag}
          <button
            type="button"
            onMouseDown={e => { e.preventDefault(); remove(tag); }}
            className="text-stone-400 hover:text-stone-700 transition-colors"
            tabIndex={-1}
            aria-label={`Remove ${tag}`}
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
      <div className="flex items-center flex-1 gap-1.5 min-w-[120px]">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => commit(input)}
          placeholder={value.length === 0 ? placeholder : ''}
          className="flex-1 text-sm outline-none bg-transparent placeholder-stone-300 text-stone-800 py-0.5"
        />
        {input.trim() && (
          <button
            type="button"
            onMouseDown={e => { e.preventDefault(); commit(input); }}
            className="shrink-0 flex items-center justify-center w-5 h-5 rounded bg-stone-800 text-white hover:bg-stone-700 transition-colors"
            aria-label="Add tag"
            tabIndex={-1}
          >
            <Plus className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}
