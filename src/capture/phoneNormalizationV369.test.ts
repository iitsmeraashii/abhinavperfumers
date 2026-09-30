// Tests for Version 369 phone-normalization integration gaps.
// Run with: npx tsx src/capture/phoneNormalizationV369.test.ts

import { resolvePhoneCountry, isInternationalPhone } from './phoneCountryResolver';
import { normalizePhone, phoneDedupKey } from './normalizePhone';
import { resolveWhatsAppPhone } from './whatsappPhoneResolver';
import { COUNTRIES } from './countryData';

let passed = 0;
let failed = 0;

function assertEq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; } else {
    failed++;
    console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

function assertTrue(v: boolean, label: string): void {
  if (v) { passed++; } else { failed++; console.error(`FAIL (expected true): ${label}`); }
}

// ─── 1. RESOLVER: international phone precedence ──────────────────────────────

// +971501234567 with conflicting +91 selection → resolver returns +971
{
  const resolved = resolvePhoneCountry({
    phone: '+971501234567',
    selectedDialCode: '+91',
    isManualCapture: false,
  });
  assertEq(resolved, '+971', 'R1: +971 phone with +91 selected → resolver returns +971');
}

// +919876543210 with conflicting +971 selection → resolver returns +91
{
  const resolved = resolvePhoneCountry({
    phone: '+919876543210',
    selectedDialCode: '+971',
    isManualCapture: false,
  });
  assertEq(resolved, '+91', 'R2: +91 phone with +971 selected → resolver returns +91');
}

// 00971501234567 → resolver returns +971
{
  const resolved = resolvePhoneCountry({
    phone: '00971501234567',
    isManualCapture: false,
  });
  assertEq(resolved, '+971', 'R3: 00971 prefix → resolver returns +971');
}

// +447911123456 → resolver returns +44 (UK, Isle of Man, Guernsey, Jersey share +44)
// Since +44 is shared, resolver returns null. Normalization still works.
{
  const resolved = resolvePhoneCountry({
    phone: '+447911123456',
    isManualCapture: false,
  });
  assertEq(resolved, null, 'R4: +44 shared dial code → resolver returns null (ambiguous)');

  // Normalization still works for +44 numbers
  const normalized = normalizePhone('+447911123456');
  assertEq(normalized, { ok: true, value: '447911123456' }, 'R4b: +44 normalization works without dial code');
}

// +1 (ambiguous, shared by US/Canada) → resolver returns null
{
  const resolved = resolvePhoneCountry({
    phone: '+14155552671',
    isManualCapture: false,
  });
  assertEq(resolved, null, 'R5: +1 ambiguous → resolver returns null');
}

// International phone wins over manual +91 default
{
  const resolved = resolvePhoneCountry({
    phone: '+971501234567',
    isManualCapture: true,
  });
  assertEq(resolved, '+971', 'R6: +971 international wins over Indian-mobile +91 default');
}

// ─── 2. RESOLVER: normalization ignores conflicting selector for international ─

{
  const resolved = resolvePhoneCountry({
    phone: '+971501234567',
    selectedDialCode: '+91',
    isManualCapture: false,
  });
  const normalized = normalizePhone('+971501234567', { dialCode: resolved ?? undefined });
  assertEq(normalized, { ok: true, value: '971501234567' }, 'N1: +971 with +91 selected → 971501234567');
}

// ─── 3. BARE-INTERNATIONAL DEDUP ──────────────────────────────────────────────

// 919876543210 with +91 context → 919876543210 (not 91919876543210)
{
  const result = normalizePhone('919876543210', { dialCode: '+91' });
  assertEq(result, { ok: true, value: '919876543210' }, 'D1: bare 919876543210 + +91 → 919876543210');
}

// 971501234567 with +971 context → 971501234567
{
  const result = normalizePhone('971501234567', { dialCode: '+971' });
  assertEq(result, { ok: true, value: '971501234567' }, 'D2: bare 971501234567 + +971 → 971501234567');
}

// All three representations dedup to same canonical with +91 context
{
  const dc = '+91';
  const k1 = phoneDedupKey('+91 98765 43210', { dialCode: dc });
  const k2 = phoneDedupKey('919876543210', { dialCode: dc });
  const k3 = phoneDedupKey('0091 98765 43210', { dialCode: dc });
  assertEq(k1, '919876543210', 'D3: dedupKey +91 98765 43210 → 919876543210');
  assertEq(k2, '919876543210', 'D4: dedupKey 919876543210 → 919876543210');
  assertEq(k3, '919876543210', 'D5: dedupKey 0091 98765 43210 → 919876543210');
  assertEq(k1, k2, 'D6: k1 === k2');
  assertEq(k2, k3, 'D7: k2 === k3');
}

// +971 representations dedup with +971 context
{
  const dc = '+971';
  const k1 = phoneDedupKey('+971501234567', { dialCode: dc });
  const k2 = phoneDedupKey('971501234567', { dialCode: dc });
  assertEq(k1, '971501234567', 'D8: dedupKey +971501234567 → 971501234567');
  assertEq(k2, '971501234567', 'D9: dedupKey 971501234567 → 971501234567');
  assertEq(k1, k2, 'D10: +971 and bare 971 dedup together');
}

// Full dedup array: three representations → one
{
  const dc = '+91';
  const rawPhones = ['+91 98765 43210', '919876543210', '0091 98765 43210'];
  const phones: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawPhones) {
    const result = normalizePhone(raw, { dialCode: dc });
    const normalized = result.ok ? result.value : raw;
    const dedup = phoneDedupKey(raw, { dialCode: dc });
    if (dedup && seen.has(dedup)) continue;
    if (dedup) seen.add(dedup);
    phones.push(normalized);
  }
  assertEq(phones.length, 1, 'D11: Three representations → one');
  assertEq(phones[0], '919876543210', 'D12: Deduplicated value is 919876543210');
}

// ─── 4. LEAD DETAIL SAVE SIMULATION ───────────────────────────────────────────

// Simulates LeadDetailPage handleSave phone normalization
function simulateLeadDetailSave(
  phone0: string,
  phone1: string,
  phone0CountryCode: string,
  phone1CountryCode: string,
): string[] {
  const rawPhones = [phone0, phone1].map(p => p.trim()).filter(Boolean);
  const dialCodes = [phone0CountryCode, phone1CountryCode];
  const phones: string[] = [];
  const seenDedupKeys = new Set<string>();
  for (let i = 0; i < rawPhones.length; i++) {
    const raw = rawPhones[i];
    const dc = dialCodes[i] || undefined;
    const result = normalizePhone(raw, { dialCode: dc });
    const normalized = result.ok ? result.value : raw;
    const dedup = phoneDedupKey(raw, { dialCode: dc });
    if (dedup && seenDedupKeys.has(dedup)) continue;
    if (dedup) seenDedupKeys.add(dedup);
    phones.push(normalized);
  }
  return phones;
}

// A. Existing bare phone + no selection + save → unchanged
{
  const phones = simulateLeadDetailSave('9876543210', '', '', '');
  assertEq(phones, ['9876543210'], 'LD-A: bare phone, no country → unchanged');
}

// B. Existing bare phone + explicit India → normalized
{
  const phones = simulateLeadDetailSave('9876543210', '', '+91', '');
  assertEq(phones, ['919876543210'], 'LD-B: bare phone + +91 → 919876543210');
}

// C. Existing bare phone + explicit UAE → normalized using +971
{
  const phones = simulateLeadDetailSave('501234567', '', '+971', '');
  assertEq(phones, ['971501234567'], 'LD-C: bare phone + +971 → 971501234567');
}

// D. Existing international phone + conflicting selector → international wins
{
  const phones = simulateLeadDetailSave('+971501234567', '', '+91', '');
  assertEq(phones, ['971501234567'], 'LD-D: +971 with +91 selected → 971501234567');
}

// E. Phone 2 uses same combined component (verified by structure: both have dial codes)
{
  const phones = simulateLeadDetailSave('9876543210', '501234567', '+91', '+971');
  assertEq(phones[0], '919876543210', 'LD-E1: phone0 normalized with +91');
  assertEq(phones[1], '971501234567', 'LD-E2: phone1 normalized with +971');
}

// F. Existing international phone, save without changes → preserved
{
  const phones = simulateLeadDetailSave('971501234567', '', '', '');
  // No dial code, no + prefix → MISSING_COUNTRY_CONTEXT → raw preserved
  assertEq(phones, ['971501234567'], 'LD-F: bare international, no context → preserved');
}

// G. Phone ordering preserved — phone0 stays first
{
  const phones = simulateLeadDetailSave('+971501234567', '9876543210', '', '+91');
  assertEq(phones[0], '971501234567', 'LD-G1: phones[0] is international (first)');
  assertEq(phones[1], '919876543210', 'LD-G2: phones[1] is normalized local');
}

// H. Dedup across phone0 and phone1
{
  const phones = simulateLeadDetailSave('+91 98765 43210', '919876543210', '+91', '+91');
  assertEq(phones.length, 1, 'LD-H: dedup across two phones → one');
  assertEq(phones[0], '919876543210', 'LD-H: deduplicated value');
}

// ─── 5. CREATE LEAD MODAL SAVE SIMULATION ─────────────────────────────────────

function simulateCreateLeadSave(phone: string, phoneCountryCode: string): string[] {
  const phones: string[] = [];
  if (phone.trim()) {
    const result = normalizePhone(phone.trim(), {
      dialCode: phoneCountryCode || undefined,
    });
    phones.push(result.ok ? result.value : phone.trim());
  }
  return phones;
}

// Explicit India selection
{
  assertEq(simulateCreateLeadSave('9876543210', '+91'), ['919876543210'], 'CL-1: +91 selection → 919876543210');
}

// Explicit UAE selection
{
  assertEq(simulateCreateLeadSave('501234567', '+971'), ['971501234567'], 'CL-2: +971 selection → 971501234567');
}

// Existing international number
{
  assertEq(simulateCreateLeadSave('+971501234567', ''), ['971501234567'], 'CL-3: international → 971501234567');
}

// No-country local number → preserved (no guessing)
{
  assertEq(simulateCreateLeadSave('9876543210', ''), ['9876543210'], 'CL-4: no country → raw preserved');
}

// No automatic India default
{
  assertEq(simulateCreateLeadSave('501234567', ''), ['501234567'], 'CL-5: no India default for non-Indian phone');
}

// ─── 6. EXISTING-RECORD SAFETY ────────────────────────────────────────────────

// makeDraft simulation: bare 9876543210 with no dial code → phoneCountryCode derived as +91
{
  const derived = resolvePhoneCountry({ phone: '9876543210', isManualCapture: false, address: null });
  // 9876543210 is a qualifying 10-digit Indian mobile → +91 (no address needed)
  assertEq(derived, '+91', 'SAFE-1: bare Indian mobile, no address → +91 (auto-default)');
}

// makeDraft simulation: +971501234567 → derived +971
{
  const derived = resolvePhoneCountry({ phone: '+971501234567', isManualCapture: false, address: null });
  assertEq(derived, '+971', 'SAFE-2: +971 prefix → derived +971 for display');
}

// makeDraft simulation: 971501234567 (bare international) → null (no + prefix)
{
  const derived = resolvePhoneCountry({ phone: '971501234567', isManualCapture: false, address: null });
  // No + or 00 prefix, not plausible Indian mobile → null
  assertEq(derived, null, 'SAFE-3: bare 971... (no +) → null');
}

// Opening with +971 and saving without changes → preserves 971501234567
{
  const phones = simulateLeadDetailSave('+971501234567', '', '', '');
  assertEq(phones, ['971501234567'], 'SAFE-4: open + save international → preserved');
}

// Opening with bare 9876543210, no selection, save → unchanged
{
  const phones = simulateLeadDetailSave('9876543210', '', '', '');
  assertEq(phones, ['9876543210'], 'SAFE-5: open + save bare local → unchanged');
}

// ─── 7. PROMOTION BEHAVIOR (unchanged) ────────────────────────────────────────

function simulatePromotion(
  rawPhone: string | undefined,
  phoneNumbers: string[] | undefined,
  phoneCountryCode: string | undefined,
  isManualCapture: boolean,
  address: string | undefined,
): string[] {
  const rawPhones: string[] = [];
  if (rawPhone?.trim()) rawPhones.push(rawPhone.trim());
  if (phoneNumbers) {
    for (const p of phoneNumbers) {
      const t = String(p ?? '').trim();
      if (t && !rawPhones.includes(t)) rawPhones.push(t);
    }
  }
  const resolvedDialCode = resolvePhoneCountry({
    phone: rawPhones[0] ?? null,
    selectedDialCode: phoneCountryCode ?? null,
    isManualCapture,
    address: address ?? null,
  });
  // Promotion now stores RAW phones, not normalized.
  // Dedup by canonical key but preserve the raw value.
  const phones: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawPhones) {
    const dedup = phoneDedupKey(raw, { dialCode: resolvedDialCode ?? undefined });
    if (dedup && seen.has(dedup)) continue;
    if (dedup) seen.add(dedup);
    phones.push(raw);
  }
  return phones;
}

// Manual: 9876543210 → raw preserved (WhatsApp normalizes downstream)
{
  assertEq(simulatePromotion('9876543210', undefined, undefined, true, undefined), ['9876543210'], 'P1: manual → raw 9876543210 preserved');
}

// International: +971 → raw preserved
{
  assertEq(simulatePromotion('+971501234567', undefined, '+91', false, 'India'), ['+971501234567'], 'P2: international raw preserved');
}

// Ordering preserved
{
  const phones = simulatePromotion('9876543210', ['+971501234567'], '+91', true, undefined);
  assertEq(phones[0], '9876543210', 'P3: phones[0] raw preserved');
  assertEq(phones[1], '+971501234567', 'P4: phones[1] raw preserved');
}

// Multiple local phones — raw preserved, dedup by canonical key
{
  const phones = simulatePromotion('9876543210', ['501234567'], '+91', true, undefined);
  assertEq(phones[0], '9876543210', 'P5: phone0 raw preserved');
  assertEq(phones[1], '501234567', 'P6: phone1 raw preserved');
}

// Non-manual qualifying Indian mobile — raw preserved
{
  assertEq(simulatePromotion('9876543210', undefined, undefined, false, undefined), ['9876543210'], 'P7: qualifying Indian mobile raw preserved');
}

// WhatsApp normalization of promoted raw phones
{
  const promoted = simulatePromotion('+91 87963 14123', undefined, undefined, false, undefined);
  assertEq(promoted, ['+91 87963 14123'], 'P8: raw formatted international preserved in phones[]');
  // WhatsApp resolves it to canonical digits
  const wa = resolveWhatsAppPhone(promoted[0]);
  assertEq(wa, '918796314123', 'P9: WhatsApp normalizes +91 87963 14123 → 918796314123');
}

// ─── 8. LEAD COUNTRY ISOLATION ────────────────────────────────────────────────

{
  // Lead country = India, phone country = UAE
  const phoneCountry = resolvePhoneCountry({
    phone: '501234567', selectedDialCode: '+971', isManualCapture: false, address: 'Mumbai, India',
  });
  assertEq(phoneCountry, '+971', 'ISO-1: phone country +971 despite Indian address');

  // Lead country = UAE, phone country = India (qualifying mobile auto-defaults)
  const phoneCountry2 = resolvePhoneCountry({
    phone: '9876543210', selectedDialCode: '+91', isManualCapture: false, address: 'Dubai, UAE',
  });
  assertEq(phoneCountry2, '+91', 'ISO-2: phone country +91 despite UAE address (qualifying mobile + user selection)');
}

// ─── 9. DIAL CODE STORAGE ─────────────────────────────────────────────────────

{
  const validDialCodes = ['+91', '+971', '+44', '+966'];
  for (const dc of validDialCodes) {
    const country = COUNTRIES.find(c => c.dialCode === dc);
    assertTrue(country !== undefined, `DC: "${dc}" is a valid dial code in COUNTRIES`);
    assertTrue(dc.startsWith('+'), `DC: "${dc}" starts with +`);
  }
}

// ─── 10. NO-CONTEXT BEHAVIOR ──────────────────────────────────────────────────

{
  const result = normalizePhone('9876543210');
  assertEq(result, { ok: false, value: null, reason: 'MISSING_COUNTRY_CONTEXT' }, 'NC: no context → MISSING_COUNTRY_CONTEXT');

  // In save simulation, raw is preserved
  const phones = simulateLeadDetailSave('9876543210', '', '', '');
  assertEq(phones, ['9876543210'], 'NC: raw preserved when no context');
}

// ─── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
