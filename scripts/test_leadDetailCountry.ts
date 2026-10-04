import { readFileSync } from 'node:fs';
import { canonicalizeCountry, findCountryByName, searchCountries } from '../src/capture/countryData';

const leadDetail = readFileSync('src/LeadDetailPage.tsx', 'utf8');
const countrySelector = readFileSync('src/capture/CountrySelector.tsx', 'utf8');
const phoneCountrySelector = readFileSync('src/capture/PhoneCountrySelector.tsx', 'utf8');

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    return;
  }
  failed++;
  console.error(`FAIL: ${label}`);
}

const countryFieldStart = leadDetail.indexOf('<CountrySelector');
const countryFieldEnd = leadDetail.indexOf('/>', countryFieldStart);
const countryField = leadDetail.slice(countryFieldStart, countryFieldEnd);

assert(countryField.includes('showDialCode={false}'), '1: Lead Country hides dial codes');
assert(countryField.includes('value={draft.country'), '2: Lead Country displays saved draft country');
assert(countryField.includes("patchDraft('country', c ?? '')"), '3: selecting a country updates draft.country');
assert(countryField.includes('placeholder="Select country"'), '4: empty Lead Country uses exact placeholder');
assert(!countryField.includes('PhoneCountrySelector'), '5: Lead Country does not use phone selector');
assert(countrySelector.includes('onChange(countryName)'), '6: canonical selector returns country name');
assert(countrySelector.includes('showDialCode = true'), '7: canonical selector preserves existing default behavior');
assert(phoneCountrySelector.includes('onChange(dialCode)'), '8: phone selector remains dial-code based');
assert(findCountryByName('India')?.name === 'India', '9: saved India resolves as India');
assert(canonicalizeCountry('Saudi Arabia') === 'Saudi Arabia', '10: Saudi Arabia canonical value is country name');
assert(canonicalizeCountry('United Arab Emirates') === 'United Arab Emirates', '11: UAE canonical value is country name');
assert(searchCountries('Saudi Arabia').some(country => country.name === 'Saudi Arabia'), '12: country search returns country names');
assert(!searchCountries('Saudi Arabia').some(country => country.name === '+966'), '13: country search does not return dial codes as names');

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
