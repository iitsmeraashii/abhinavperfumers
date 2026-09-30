// Searchable phone-country selector component.
//
// Conceptually separate from the lead/business CountrySelector.
// Allows the rep to pick the dial-code context for a phone number.
// Does NOT include "UNSURE" as a selectable option.
//
// The dropdown renders via a React portal to document.body, matching
// the pattern used by CountrySelector.

import { useState, useRef, useEffect, useMemo, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Search, X, Check, Phone } from 'lucide-react';
import { searchCountries, COUNTRIES } from './countryData';

interface PhoneCountrySelectorProps {
  /** Phone dial code (e.g. '+91'), or null/undefined if unset. */
  value: string | null | undefined;
  /** Called with the dial code (e.g. '+91'), or null when cleared. */
  onChange: (dialCode: string | null) => void;
  placeholder?: string;
}

interface DropdownPosition {
  left: number;
  top: number;
  width: number;
}

export function PhoneCountrySelector({
  value,
  onChange,
  placeholder = 'Select phone country…',
}: PhoneCountrySelectorProps) {
  const [query, setQuery]           = useState('');
  const [open, setOpen]             = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [dropdownPos, setDropdownPos] = useState<DropdownPosition | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef     = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (!open || !containerRef.current) return;

    function recompute() {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      setDropdownPos({
        left:  rect.left + window.scrollX,
        top:   rect.bottom + window.scrollY + 4,
        width: rect.width,
      });
    }

    recompute();
    window.addEventListener('scroll', recompute, true);
    window.addEventListener('resize', recompute);
    return () => {
      window.removeEventListener('scroll', recompute, true);
      window.removeEventListener('resize', recompute);
    };
  }, [open]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
        setHighlighted(0);
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const results = useMemo(() => {
    if (!open) return [];
    return searchCountries(query).slice(0, 80);
  }, [open, query]);

  const selectedCountry = value
    ? COUNTRIES.find(c => c.dialCode === value)
    : undefined;

  function handleSelect(dialCode: string) {
    onChange(dialCode);
    setOpen(false);
    setQuery('');
    setHighlighted(0);
  }

  function handleClear() {
    onChange(null);
    setQuery('');
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted(prev => Math.min(prev + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[highlighted]) {
        handleSelect(results[highlighted].dialCode);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      setQuery('');
    }
  }

  return (
    <div ref={containerRef} className="relative">
      {!open ? (
        <div
          onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 0); }}
          className="w-full px-3 py-1.5 text-sm border border-stone-200 rounded-lg bg-white text-stone-800
            focus:ring-2 focus:ring-amber-500 focus:border-transparent transition cursor-pointer
            hover:border-stone-300 flex items-center gap-2 min-h-[38px]"
        >
          <Phone className="w-4 h-4 text-stone-400 flex-shrink-0" />
          {selectedCountry ? (
            <span className="flex-1">
              {selectedCountry.name}
              <span className="text-stone-400 ml-1.5">({selectedCountry.dialCode})</span>
            </span>
          ) : (
            <span className="flex-1 text-stone-400">{placeholder}</span>
          )}
          {selectedCountry && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleClear(); }}
              className="text-stone-400 hover:text-stone-600 transition flex-shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      ) : (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400 pointer-events-none" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => { setQuery(e.target.value); setHighlighted(0); }}
            onKeyDown={handleKeyDown}
            placeholder="Search phone country…"
            className="w-full pl-9 pr-3 py-1.5 text-sm border border-amber-400 rounded-lg bg-white
              text-stone-800 placeholder-stone-400 focus:ring-2 focus:ring-amber-500
              focus:border-transparent transition outline-none min-h-[38px]"
            autoFocus
          />
        </div>
      )}

      {open && dropdownPos && createPortal(
        <div
          style={{
            position: 'absolute',
            left:  dropdownPos.left,
            top:   dropdownPos.top,
            width: dropdownPos.width,
          }}
          className="z-[9999] max-h-64 overflow-y-auto bg-white border border-stone-200
            rounded-lg shadow-xl divide-y divide-stone-50"
        >
          {results.length === 0 ? (
            <div className="px-3 py-3 text-sm text-stone-400 text-center">
              No countries found
            </div>
          ) : (
            results.map((country, index) => (
              <button
                key={country.code}
                type="button"
                onClick={() => handleSelect(country.name)}
                onMouseEnter={() => setHighlighted(index)}
                className={`w-full px-3 py-2 text-sm text-left flex items-center justify-between
                  transition-colors ${index === highlighted ? 'bg-amber-50' : 'hover:bg-stone-50'}
                  ${value === country.dialCode ? 'font-semibold text-amber-700' : 'text-stone-700'}`}
              >
                <span>{country.name}</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-stone-400">{country.dialCode}</span>
                  {value === country.dialCode && (
                    <Check className="w-3.5 h-3.5 text-amber-600" />
                  )}
                </div>
              </button>
            ))
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
