// Combined phone input with integrated country/dial-code selector.
//
// Renders ONE control: [ Country (dial code) ▾ ] [ phone number ]
// The country selector is visually attached to the phone input as a prefix.
//
// Uses dial codes as the state representation for phoneCountryCode.

import { useState, useRef, useEffect, useMemo, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Search, Check, ChevronDown } from 'lucide-react';
import { searchCountries, COUNTRIES } from './countryData';

interface PhoneInputWithCountryProps {
  /** Phone dial code (e.g. '+91'), or null/undefined if unset. */
  phoneCountryCode: string | null | undefined;
  /** Called when the dial code selection changes (dial code or null). */
  onPhoneCountryChange: (dialCode: string | null) => void;
  /** The raw phone number value. */
  phoneValue: string;
  /** Called when the phone number text changes. */
  onPhoneChange: (value: string) => void;
  /** Optional placeholder for the phone input. */
  phonePlaceholder?: string;
  /** Whether the phone field is required. */
  required?: boolean;
  /** Error message for the phone field. */
  error?: string;
  /** Called when the phone input loses focus. */
  onPhoneBlur?: () => void;
  /** Additional CSS classes for the container. */
  className?: string;
  /**
   * Dial code derived from the phone number's international prefix, if any.
   * Used as a display fallback when phoneCountryCode is empty/null — shown
   * before the user has made an explicit selection. phoneCountryCode always
   * takes priority; this value never overrides an explicit user selection.
   */
  derivedDialCode?: string | null;
}

interface DropdownPosition {
  left: number;
  top: number;
  width: number;
}

export function PhoneInputWithCountry({
  phoneCountryCode,
  onPhoneCountryChange,
  phoneValue,
  onPhoneChange,
  phonePlaceholder = 'Phone number',
  required,
  error,
  onPhoneBlur,
  className = '',
  derivedDialCode,
}: PhoneInputWithCountryProps) {
  const [query, setQuery]             = useState('');
  const [open, setOpen]               = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [dropdownPos, setDropdownPos] = useState<DropdownPosition | null>(null);

  const prefixRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const phoneRef  = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (!open || !prefixRef.current) return;

    function recompute() {
      if (!prefixRef.current) return;
      const rect = prefixRef.current.getBoundingClientRect();
      setDropdownPos({
        left:  rect.left + window.scrollX,
        top:   rect.bottom + window.scrollY + 4,
        width: Math.max(rect.width, 220),
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
      if (open && prefixRef.current && !prefixRef.current.contains(e.target as Node)) {
        // Also check the dropdown portal — it's in document.body, not a child of prefixRef
        const target = e.target as HTMLElement;
        if (target.closest('[data-phone-country-dropdown]')) return;
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

  // The display dial code: an explicit user selection (phoneCountryCode) takes
  // priority. derivedDialCode is only used as a fallback when no explicit
  // selection exists (e.g. a new form where the phone's own international
  // prefix identifies the country before the user has made a selection).
  const displayDialCode = phoneCountryCode ?? derivedDialCode;

  const selectedCountry = displayDialCode
    ? COUNTRIES.find(c => c.dialCode === displayDialCode)
    : undefined;

  function handleSelect(dialCode: string) {
    onPhoneCountryChange(dialCode);
    setOpen(false);
    setQuery('');
    setHighlighted(0);
    setTimeout(() => phoneRef.current?.focus(), 0);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === ' ') {
        e.preventDefault();
        setOpen(true);
        setTimeout(() => searchRef.current?.focus(), 0);
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
      setTimeout(() => phoneRef.current?.focus(), 0);
    }
  }

  const borderCls = error
    ? 'border-red-300'
    : 'border-stone-200';

  return (
    <div className={`relative ${className}`}>
      <div className={`flex items-stretch border ${borderCls} rounded-lg bg-white overflow-hidden
        focus-within:ring-2 focus-within:ring-amber-500 focus-within:border-transparent transition`}>

        {/* ── Country/dial-code prefix selector ── */}
        <button
          ref={prefixRef}
          type="button"
          onClick={() => {
            if (!open) {
              setOpen(true);
              setTimeout(() => searchRef.current?.focus(), 0);
            } else {
              setOpen(false);
              setQuery('');
            }
          }}
          onKeyDown={handleKeyDown}
          className={`flex items-center gap-1 px-3 text-sm whitespace-nowrap
            border-r border-stone-200 bg-stone-50 hover:bg-stone-100 transition
            ${selectedCountry ? 'text-stone-700' : 'text-stone-400'} flex-shrink-0`}
        >
          {selectedCountry ? (
            <span className="flex items-center gap-1">
              <span className="hidden sm:inline">{selectedCountry.name}</span>
              <span className="sm:hidden">{selectedCountry.code}</span>
              <span className="text-stone-400 font-normal">({selectedCountry.dialCode})</span>
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <span>Select</span>
            </span>
          )}
          <ChevronDown className="w-3.5 h-3.5 text-stone-400" />
        </button>

        {/* ── Phone number input ── */}
        <input
          ref={phoneRef}
          type="tel"
          inputMode="tel"
          value={phoneValue}
          onChange={e => onPhoneChange(e.target.value)}
          onBlur={onPhoneBlur}
          placeholder={phonePlaceholder}
          required={required}
          className="flex-1 min-w-0 px-3 py-2 text-sm bg-white text-stone-800
            placeholder:text-stone-400 outline-none"
        />
      </div>

      {error && <p className="text-xs text-red-500 mt-1">{error}</p>}

      {/* ── Dropdown (portal to document.body) ── */}
      {open && dropdownPos && createPortal(
        <div
          data-phone-country-dropdown
          style={{
            position: 'absolute',
            left:  dropdownPos.left,
            top:   dropdownPos.top,
            width: dropdownPos.width,
          }}
          className="z-[9999] max-h-64 overflow-y-auto bg-white border border-stone-200
            rounded-lg shadow-xl divide-y divide-stone-50"
        >
          {/* Search input inside dropdown */}
          <div className="sticky top-0 bg-white p-2 border-b border-stone-100">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-400 pointer-events-none" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={e => { setQuery(e.target.value); setHighlighted(0); }}
                onKeyDown={handleKeyDown}
                placeholder="Search country…"
                className="w-full pl-8 pr-3 py-1.5 text-sm border border-stone-200 rounded-md
                  bg-white text-stone-800 placeholder:text-stone-400 outline-none
                  focus:ring-2 focus:ring-amber-400 focus:border-transparent"
                autoFocus
              />
            </div>
          </div>

          {results.length === 0 ? (
            <div className="px-3 py-3 text-sm text-stone-400 text-center">
              No countries found
            </div>
          ) : (
            results.map((country, index) => (
              <button
                key={country.code}
                type="button"
                onClick={() => handleSelect(country.dialCode)}
                onMouseEnter={() => setHighlighted(index)}
                className={`w-full px-3 py-2 text-sm text-left flex items-center justify-between
                  transition-colors ${index === highlighted ? 'bg-amber-50' : 'hover:bg-stone-50'}
                  ${displayDialCode === country.dialCode ? 'font-semibold text-amber-700' : 'text-stone-700'}`}
              >
                <span>{country.name}</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-stone-400">{country.dialCode}</span>
                  {displayDialCode === country.dialCode && (
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
