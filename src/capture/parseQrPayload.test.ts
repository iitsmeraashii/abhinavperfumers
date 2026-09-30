// Tests for QR payload address extraction in the heuristic pipeline.
// Run with: npx tsx src/capture/parseQrPayload.test.ts

import { parseQrPayload, parseExhibitionText } from './parseQrPayload';
import { deriveState } from './deriveState';
import { resolveLeadCountry } from './resolveLeadCountry';

let passed = 0;
let failed = 0;

function assertEq(actual: unknown, expected: unknown, label: string): void {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr === expectedStr) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label}`);
    console.error(`  expected: ${expectedStr}`);
    console.error(`  actual:   ${actualStr}`);
  }
}

function assertContains(haystack: unknown, needle: string, label: string): void {
  const s = String(haystack ?? '');
  if (s.includes(needle)) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label}`);
    console.error(`  expected to contain: "${needle}"`);
    console.error(`  actual:   "${s}"`);
  }
}

// ─── Case 1: Exact example from the bug report ────────────────────────────────

const case1Payload = [
  'Rajesh Kumar',
  '9953256684',
  'E-23, Sector-39, Noida - 201301, India',
].join('\n');

const case1Result = parseQrPayload(case1Payload);
assertContains(case1Result.fields.address, 'E-23, Sector-39, Noida - 201301, India', 'Case 1: address extracted');
assertEq(case1Result.fields.phone, '9953256684', 'Case 1: phone extracted');
assertEq(case1Result.fields.clientName, 'Rajesh Kumar', 'Case 1: name extracted');

// Verify downstream derivation works with the extracted address
assertEq(
  deriveState(case1Result.fields.address ?? ''),
  'Uttar Pradesh',
  'Case 1: deriveState produces Uttar Pradesh',
);
assertEq(
  resolveLeadCountry({ selectedCountry: null, address: case1Result.fields.address }),
  'India',
  'Case 1: resolveLeadCountry produces India',
);

// ─── Address with 6-digit Indian pincode only ─────────────────────────────────

const pincodePayload = 'Rahul Sharma\n+919876543210\n2nd Floor, MG Road, Pune 411001\n';
const pincodeResult = parseQrPayload(pincodePayload);
assertContains(pincodeResult.fields.address, '411001', 'Pincode: address contains pincode');
assertEq(pincodeResult.fields.phone, '+919876543210', 'Pincode: phone extracted');
assertEq(
  deriveState(pincodeResult.fields.address ?? ''),
  'Maharashtra',
  'Pincode: deriveState produces Maharashtra (Pune)',
);

// ─── Multi-line address (split across lines) ──────────────────────────────────

const multiLinePayload = [
  'Priya Patel',
  'priya@example.com',
  'Flat 4B, Sunrise Apartments',
  'Bodakdev, Ahmedabad - 380054',
  'Patel Fragrances Pvt Ltd',
].join('\n');

const multiLineResult = parseQrPayload(multiLinePayload);
assertContains(multiLineResult.fields.address, 'Flat 4B', 'Multi-line: first address line present');
assertContains(multiLineResult.fields.address, 'Bodakdev', 'Multi-line: second address line present');
assertContains(multiLineResult.fields.address, '380054', 'Multi-line: pincode present');
assertEq(multiLineResult.fields.email, 'priya@example.com', 'Multi-line: email extracted');
assertContains(multiLineResult.fields.company, 'Patel Fragrances', 'Multi-line: company extracted');
assertEq(
  deriveState(multiLineResult.fields.address ?? ''),
  'Gujarat',
  'Multi-line: deriveState produces Gujarat (Ahmedabad)',
);

// ─── QR payload with phone + address + company + name ─────────────────────────

const fullPayload = [
  'Aromatics International',
  'Suresh Mehta',
  'Director',
  '+919953256684',
  'E-23, Sector-39, Noida - 201301, India',
  'suresh@aromatics.com',
].join('\n');

const fullResult = parseQrPayload(fullPayload);
assertEq(fullResult.fields.company, 'Aromatics International', 'Full: company extracted');
assertEq(fullResult.fields.clientName, 'Suresh Mehta', 'Full: name extracted');
assertEq(fullResult.fields.designation, 'Director', 'Full: designation extracted');
assertEq(fullResult.fields.phone, '+919953256684', 'Full: phone extracted');
assertEq(fullResult.fields.email, 'suresh@aromatics.com', 'Full: email extracted');
assertContains(fullResult.fields.address, 'Sector-39', 'Full: address extracted');
assertContains(fullResult.fields.address, '201301', 'Full: pincode in address');
assertContains(fullResult.fields.address, 'India', 'Full: country in address');
// Address should NOT appear in ignoredLines
assertEq(
  (fullResult.ignoredLines ?? []).some(l => l.includes('Sector-39')),
  false,
  'Full: address line not in ignoredLines',
);

// ─── Existing QR payloads without addresses continue working ──────────────────

const noAddressPayload = 'John Doe\n+1234567890\njohn@example.com\n';
const noAddrResult = parseQrPayload(noAddressPayload);
assertEq(noAddrResult.fields.address, undefined, 'No-address: address is undefined');
assertEq(noAddrResult.fields.phone, '+1234567890', 'No-address: phone extracted');
assertEq(noAddrResult.fields.email, 'john@example.com', 'No-address: email extracted');

const nameCompanyOnly = 'Acme Industries\nJane Smith\n';
const nameCompanyResult = parseQrPayload(nameCompanyOnly);
assertEq(nameCompanyResult.fields.address, undefined, 'Name+company only: no address');
assertContains(nameCompanyResult.fields.company, 'Acme', 'Name+company: company extracted');
assertContains(nameCompanyResult.fields.clientName, 'Jane', 'Name+company: name extracted');

// ─── vCard parsing remains unchanged ──────────────────────────────────────────

const vcardPayload = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Amit Verma',
  'ORG:Verma Traders',
  'TEL:9876543210',
  'EMAIL:amit@verma.com',
  'ADR:;;123 MG Road;Indore;Madhya Pradesh;452001;India',
  'END:VCARD',
].join('\n');

const vcardResult = parseQrPayload(vcardPayload);
assertEq(vcardResult.qrType, 'vcard', 'vCard: qrType is vcard');
assertEq(vcardResult.fields.clientName, 'Amit Verma', 'vCard: name extracted');
assertEq(vcardResult.fields.company, 'Verma Traders', 'vCard: company extracted');
assertEq(vcardResult.fields.phone, '9876543210', 'vCard: phone extracted');
assertContains(vcardResult.fields.address, '123 MG Road', 'vCard: address from ADR field');
assertContains(vcardResult.fields.address, 'Indore', 'vCard: city in address');
assertContains(vcardResult.fields.address, 'India', 'vCard: country in address');

// ─── MECARD parsing remains unchanged ─────────────────────────────────────────

const mecardPayload = 'MECARD:N:Sharma,Raj;ORG:Sharma Exports;TEL:9876543210;EMAIL:raj@sharma.com;ADR:Sector 5, Gurgaon, India;;';
const mecardResult = parseQrPayload(mecardPayload);
assertEq(mecardResult.qrType, 'mecard', 'MECARD: qrType is mecard');
assertEq(mecardResult.fields.clientName, 'Raj Sharma', 'MECARD: name extracted');
assertEq(mecardResult.fields.phone, '9876543210', 'MECARD: phone extracted');
assertContains(mecardResult.fields.address, 'Gurgaon', 'MECARD: address extracted');

// ─── parseExhibitionText directly: address field in HeuristicResult ───────────

const heuristicResult = parseExhibitionText(case1Payload);
assertContains(heuristicResult?.fields.address, 'E-23, Sector-39', 'Heuristic: address in fields');
assertEq(
  heuristicResult?.inferredFields.includes('address'),
  true,
  'Heuristic: address in inferredFields',
);

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
