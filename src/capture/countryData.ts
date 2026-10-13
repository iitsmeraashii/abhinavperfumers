// Canonical country data source — used by Manual Entry, Lead Detail editing,
// and address-based country derivation.
//
// Each country has:
//   name      — canonical display name (e.g. "United Arab Emirates")
//   code      — ISO 3166-1 alpha-2 code (e.g. "AE")
//   dialCode  — ITU-T E.164 international dialling code (e.g. "+971")
//
// Aliases map alternate spellings/abbreviations to the canonical name.
// The alias map is case-insensitive — callers should lowercase before lookup.
//
// The list covers all UN member states (193) plus observer states and
// several territories relevant to trade-event contexts.

export interface CountryOption {
  name:     string;
  code:     string;
  dialCode: string;
}

export const COUNTRIES: CountryOption[] = [
  // ── Priority 1: India ────────────────────────────────────────────────────
  { name: 'India',                code: 'IN', dialCode: '+91'  },

  // ── Priority 2: UAE ──────────────────────────────────────────────────────
  { name: 'United Arab Emirates', code: 'AE', dialCode: '+971' },

  // ── Priority 3: GCC countries ────────────────────────────────────────────
  { name: 'Saudi Arabia',         code: 'SA', dialCode: '+966' },
  { name: 'Qatar',                code: 'QA', dialCode: '+974' },
  { name: 'Kuwait',               code: 'KW', dialCode: '+965' },
  { name: 'Oman',                 code: 'OM', dialCode: '+968' },
  { name: 'Bahrain',              code: 'BH', dialCode: '+973' },

  // ── Rest of Middle East ──────────────────────────────────────────────────
  { name: 'Israel',               code: 'IL', dialCode: '+972' },
  { name: 'Jordan',               code: 'JO', dialCode: '+962' },
  { name: 'Lebanon',              code: 'LB', dialCode: '+961' },
  { name: 'Iran',                 code: 'IR', dialCode: '+98'  },
  { name: 'Iraq',                 code: 'IQ', dialCode: '+964' },
  { name: 'Syria',                code: 'SY', dialCode: '+963' },
  { name: 'Yemen',                code: 'YE', dialCode: '+967' },
  { name: 'Palestine',            code: 'PS', dialCode: '+970' },

  // ── Rest of South Asia ───────────────────────────────────────────────────
  { name: 'Bangladesh',           code: 'BD', dialCode: '+880' },
  { name: 'Pakistan',             code: 'PK', dialCode: '+92'  },
  { name: 'Sri Lanka',            code: 'LK', dialCode: '+94'  },
  { name: 'Nepal',                code: 'NP', dialCode: '+977' },
  { name: 'Bhutan',               code: 'BT', dialCode: '+975' },
  { name: 'Maldives',             code: 'MV', dialCode: '+960' },
  { name: 'Afghanistan',          code: 'AF', dialCode: '+93'  },

  // ── Southeast Asia ───────────────────────────────────────────────────────
  { name: 'Singapore',            code: 'SG', dialCode: '+65'  },
  { name: 'Malaysia',             code: 'MY', dialCode: '+60'  },
  { name: 'Thailand',             code: 'TH', dialCode: '+66'  },
  { name: 'Indonesia',            code: 'ID', dialCode: '+62'  },
  { name: 'Vietnam',              code: 'VN', dialCode: '+84'  },
  { name: 'Philippines',          code: 'PH', dialCode: '+63'  },
  { name: 'Myanmar',              code: 'MM', dialCode: '+95'  },
  { name: 'Cambodia',             code: 'KH', dialCode: '+855' },
  { name: 'Laos',                 code: 'LA', dialCode: '+856' },
  { name: 'Brunei',               code: 'BN', dialCode: '+673' },
  { name: 'Timor-Leste',          code: 'TL', dialCode: '+670' },

  // ── East Asia ────────────────────────────────────────────────────────────
  { name: 'China',                code: 'CN', dialCode: '+86'  },
  { name: 'Hong Kong',            code: 'HK', dialCode: '+852' },
  { name: 'Japan',                code: 'JP', dialCode: '+81'  },
  { name: 'South Korea',          code: 'KR', dialCode: '+82'  },
  { name: 'Taiwan',               code: 'TW', dialCode: '+886' },
  { name: 'Mongolia',             code: 'MN', dialCode: '+976' },
  { name: 'North Korea',          code: 'KP', dialCode: '+850' },
  { name: 'Macau',                code: 'MO', dialCode: '+853' },

  // ── Central Asia ─────────────────────────────────────────────────────────
  { name: 'Kazakhstan',           code: 'KZ', dialCode: '+7'   },
  { name: 'Uzbekistan',           code: 'UZ', dialCode: '+998' },
  { name: 'Turkmenistan',         code: 'TM', dialCode: '+993' },
  { name: 'Kyrgyzstan',           code: 'KG', dialCode: '+996' },
  { name: 'Tajikistan',           code: 'TJ', dialCode: '+992' },

  // ── Africa — North ───────────────────────────────────────────────────────
  { name: 'Egypt',                code: 'EG', dialCode: '+20'  },
  { name: 'Morocco',              code: 'MA', dialCode: '+212' },
  { name: 'Algeria',              code: 'DZ', dialCode: '+213' },
  { name: 'Tunisia',              code: 'TN', dialCode: '+216' },
  { name: 'Libya',                code: 'LY', dialCode: '+218' },
  { name: 'Sudan',                code: 'SD', dialCode: '+249' },
  { name: 'South Sudan',          code: 'SS', dialCode: '+211' },

  // ── Africa — West ────────────────────────────────────────────────────────
  { name: 'Nigeria',              code: 'NG', dialCode: '+234' },
  { name: 'Ghana',                code: 'GH', dialCode: '+233' },
  { name: 'Senegal',              code: 'SN', dialCode: '+221' },
  { name: 'Ivory Coast',          code: 'CI', dialCode: '+225' },
  { name: 'Cameroon',             code: 'CM', dialCode: '+237' },
  { name: 'Burkina Faso',         code: 'BF', dialCode: '+226' },
  { name: 'Mali',                 code: 'ML', dialCode: '+223' },
  { name: 'Guinea',               code: 'GN', dialCode: '+224' },
  { name: 'Benin',                code: 'BJ', dialCode: '+229' },
  { name: 'Niger',                code: 'NE', dialCode: '+227' },
  { name: 'Togo',                 code: 'TG', dialCode: '+228' },
  { name: 'Liberia',              code: 'LR', dialCode: '+231' },
  { name: 'Sierra Leone',         code: 'SL', dialCode: '+232' },
  { name: 'Mauritania',           code: 'MR', dialCode: '+222' },
  { name: 'Gambia',               code: 'GM', dialCode: '+220' },
  { name: 'Cape Verde',           code: 'CV', dialCode: '+238' },

  // ── Africa — East ────────────────────────────────────────────────────────
  { name: 'Kenya',                code: 'KE', dialCode: '+254' },
  { name: 'Ethiopia',             code: 'ET', dialCode: '+251' },
  { name: 'Tanzania',             code: 'TZ', dialCode: '+255' },
  { name: 'Uganda',               code: 'UG', dialCode: '+256' },
  { name: 'Rwanda',               code: 'RW', dialCode: '+250' },
  { name: 'Burundi',              code: 'BI', dialCode: '+257' },
  { name: 'Somalia',              code: 'SO', dialCode: '+252' },
  { name: 'Djibouti',             code: 'DJ', dialCode: '+253' },
  { name: 'Eritrea',              code: 'ER', dialCode: '+291' },
  { name: 'Mozambique',           code: 'MZ', dialCode: '+258' },
  { name: 'Madagascar',           code: 'MG', dialCode: '+261' },
  { name: 'Mauritius',            code: 'MU', dialCode: '+230' },
  { name: 'Seychelles',           code: 'SC', dialCode: '+248' },
  { name: 'Comoros',              code: 'KM', dialCode: '+269' },
  { name: 'Malawi',               code: 'MW', dialCode: '+265' },
  { name: 'Zambia',               code: 'ZM', dialCode: '+260' },

  // ── Africa — Central ─────────────────────────────────────────────────────
  { name: 'Democratic Republic of the Congo', code: 'CD', dialCode: '+243' },
  { name: 'Republic of the Congo',            code: 'CG', dialCode: '+242' },
  { name: 'Central African Republic',         code: 'CF', dialCode: '+236' },
  { name: 'Gabon',               code: 'GA', dialCode: '+241' },
  { name: 'Chad',                code: 'TD', dialCode: '+235' },
  { name: 'Equatorial Guinea',   code: 'GQ', dialCode: '+240' },
  { name: 'Sao Tome and Principe', code: 'ST', dialCode: '+239' },

  // ── Africa — Southern ────────────────────────────────────────────────────
  { name: 'South Africa',         code: 'ZA', dialCode: '+27'  },
  { name: 'Zimbabwe',             code: 'ZW', dialCode: '+263' },
  { name: 'Botswana',             code: 'BW', dialCode: '+267' },
  { name: 'Namibia',              code: 'NA', dialCode: '+264' },
  { name: 'Angola',               code: 'AO', dialCode: '+244' },
  { name: 'Eswatini',             code: 'SZ', dialCode: '+268' },
  { name: 'Lesotho',              code: 'LS', dialCode: '+266' },

  // ── Europe — Western ─────────────────────────────────────────────────────
  { name: 'United Kingdom',       code: 'GB', dialCode: '+44'  },
  { name: 'Ireland',              code: 'IE', dialCode: '+353' },
  { name: 'France',               code: 'FR', dialCode: '+33'  },
  { name: 'Germany',              code: 'DE', dialCode: '+49'  },
  { name: 'Netherlands',          code: 'NL', dialCode: '+31'  },
  { name: 'Belgium',              code: 'BE', dialCode: '+32'  },
  { name: 'Luxembourg',           code: 'LU', dialCode: '+352' },
  { name: 'Switzerland',          code: 'CH', dialCode: '+41'  },
  { name: 'Austria',              code: 'AT', dialCode: '+43'  },
  { name: 'Liechtenstein',        code: 'LI', dialCode: '+423' },
  { name: 'Monaco',               code: 'MC', dialCode: '+377' },
  { name: 'Andorra',              code: 'AD', dialCode: '+376' },
  { name: 'San Marino',           code: 'SM', dialCode: '+378' },
  { name: 'Vatican City',         code: 'VA', dialCode: '+379' },
  { name: 'Isle of Man',          code: 'IM', dialCode: '+44'  },
  { name: 'Guernsey',             code: 'GG', dialCode: '+44'  },
  { name: 'Jersey',               code: 'JE', dialCode: '+44'  },
  { name: 'Gibraltar',            code: 'GI', dialCode: '+350' },

  // ── Europe — Northern ────────────────────────────────────────────────────
  { name: 'Sweden',               code: 'SE', dialCode: '+46'  },
  { name: 'Norway',               code: 'NO', dialCode: '+47'  },
  { name: 'Denmark',              code: 'DK', dialCode: '+45'  },
  { name: 'Finland',              code: 'FI', dialCode: '+358' },
  { name: 'Iceland',              code: 'IS', dialCode: '+354' },
  { name: 'Estonia',              code: 'EE', dialCode: '+372' },
  { name: 'Latvia',               code: 'LV', dialCode: '+371' },
  { name: 'Lithuania',            code: 'LT', dialCode: '+370' },

  // ── Europe — Southern ────────────────────────────────────────────────────
  { name: 'Italy',                code: 'IT', dialCode: '+39'  },
  { name: 'Spain',                code: 'ES', dialCode: '+34'  },
  { name: 'Portugal',             code: 'PT', dialCode: '+351' },
  { name: 'Greece',               code: 'GR', dialCode: '+30'  },
  { name: 'Malta',                code: 'MT', dialCode: '+356' },
  { name: 'Cyprus',               code: 'CY', dialCode: '+357' },
  { name: 'Croatia',              code: 'HR', dialCode: '+385' },
  { name: 'Slovenia',             code: 'SI', dialCode: '+386' },

  // ── Europe — Central / Eastern ───────────────────────────────────────────
  { name: 'Poland',               code: 'PL', dialCode: '+48'  },
  { name: 'Czech Republic',       code: 'CZ', dialCode: '+420' },
  { name: 'Slovakia',             code: 'SK', dialCode: '+421' },
  { name: 'Hungary',              code: 'HU', dialCode: '+36'  },
  { name: 'Romania',              code: 'RO', dialCode: '+40'  },
  { name: 'Bulgaria',             code: 'BG', dialCode: '+359' },
  { name: 'Albania',              code: 'AL', dialCode: '+355' },
  { name: 'North Macedonia',      code: 'MK', dialCode: '+389' },
  { name: 'Serbia',               code: 'RS', dialCode: '+381' },
  { name: 'Bosnia and Herzegovina', code: 'BA', dialCode: '+387' },
  { name: 'Montenegro',           code: 'ME', dialCode: '+382' },
  { name: 'Kosovo',               code: 'XK', dialCode: '+383' },
  { name: 'Moldova',              code: 'MD', dialCode: '+373' },
  { name: 'Belarus',              code: 'BY', dialCode: '+375' },
  { name: 'Ukraine',              code: 'UA', dialCode: '+380' },
  { name: 'Russia',               code: 'RU', dialCode: '+7'   },
  { name: 'Turkey',               code: 'TR', dialCode: '+90'  },

  // ── North America ────────────────────────────────────────────────────────
  { name: 'United States',        code: 'US', dialCode: '+1'   },
  { name: 'Canada',               code: 'CA', dialCode: '+1'   },
  { name: 'Mexico',               code: 'MX', dialCode: '+52'  },
  { name: 'Greenland',            code: 'GL', dialCode: '+299' },
  { name: 'Bermuda',              code: 'BM', dialCode: '+1'   },
  { name: 'Cayman Islands',       code: 'KY', dialCode: '+1'   },
  { name: 'Bahamas',              code: 'BS', dialCode: '+1'   },
  { name: 'Barbados',             code: 'BB', dialCode: '+1'   },
  { name: 'Trinidad and Tobago',  code: 'TT', dialCode: '+1'   },
  { name: 'Jamaica',              code: 'JM', dialCode: '+1'   },
  { name: 'Puerto Rico',          code: 'PR', dialCode: '+1'   },

  // ── Central America ──────────────────────────────────────────────────────
  { name: 'Guatemala',            code: 'GT', dialCode: '+502' },
  { name: 'Honduras',             code: 'HN', dialCode: '+504' },
  { name: 'El Salvador',          code: 'SV', dialCode: '+503' },
  { name: 'Nicaragua',            code: 'NI', dialCode: '+505' },
  { name: 'Costa Rica',           code: 'CR', dialCode: '+506' },
  { name: 'Panama',               code: 'PA', dialCode: '+507' },
  { name: 'Belize',               code: 'BZ', dialCode: '+501' },

  // ── South America ────────────────────────────────────────────────────────
  { name: 'Brazil',               code: 'BR', dialCode: '+55'  },
  { name: 'Argentina',            code: 'AR', dialCode: '+54'  },
  { name: 'Chile',                code: 'CL', dialCode: '+56'  },
  { name: 'Colombia',             code: 'CO', dialCode: '+57'  },
  { name: 'Peru',                 code: 'PE', dialCode: '+51'  },
  { name: 'Venezuela',            code: 'VE', dialCode: '+58'  },
  { name: 'Ecuador',              code: 'EC', dialCode: '+593' },
  { name: 'Bolivia',              code: 'BO', dialCode: '+591' },
  { name: 'Paraguay',             code: 'PY', dialCode: '+595' },
  { name: 'Uruguay',              code: 'UY', dialCode: '+598' },
  { name: 'Guyana',               code: 'GY', dialCode: '+592' },
  { name: 'Suriname',             code: 'SR', dialCode: '+597' },
  { name: 'Falkland Islands',     code: 'FK', dialCode: '+500' },

  // ── Oceania ──────────────────────────────────────────────────────────────
  { name: 'Australia',            code: 'AU', dialCode: '+61'  },
  { name: 'New Zealand',          code: 'NZ', dialCode: '+64'  },
  { name: 'Fiji',                 code: 'FJ', dialCode: '+679' },
  { name: 'Papua New Guinea',     code: 'PG', dialCode: '+675' },
  { name: 'Solomon Islands',      code: 'SB', dialCode: '+677' },
  { name: 'Vanuatu',              code: 'VU', dialCode: '+678' },
  { name: 'Samoa',                code: 'WS', dialCode: '+685' },
  { name: 'Tonga',                code: 'TO', dialCode: '+676' },
  { name: 'Kiribati',             code: 'KI', dialCode: '+686' },
  { name: 'Marshall Islands',     code: 'MH', dialCode: '+692' },
  { name: 'Micronesia',           code: 'FM', dialCode: '+691' },
  { name: 'Nauru',                code: 'NR', dialCode: '+674' },
  { name: 'Palau',                code: 'PW', dialCode: '+680' },
  { name: 'Tuvalu',               code: 'TV', dialCode: '+688' },
];

// ─── Alias map ───────────────────────────────────────────────────────────────
// Maps lowercase aliases to canonical country name.
// Includes common abbreviations and alternate spellings.

const ALIAS_ENTRIES: Array<[string, string]> = [
  // India
  ['india', 'India'],
  ['bharat', 'India'],
  // UAE
  ['uae', 'United Arab Emirates'],
  ['u.a.e.', 'United Arab Emirates'],
  ['emirates', 'United Arab Emirates'],
  ['dubai', 'United Arab Emirates'],
  ['abu dhabi', 'United Arab Emirates'],
  // Saudi Arabia
  ['saudi arabia', 'Saudi Arabia'],
  ['saudi', 'Saudi Arabia'],
  ['ksa', 'Saudi Arabia'],
  // UK
  ['uk', 'United Kingdom'],
  ['u.k.', 'United Kingdom'],
  ['britain', 'United Kingdom'],
  ['great britain', 'United Kingdom'],
  ['england', 'United Kingdom'],
  ['scotland', 'United Kingdom'],
  ['wales', 'United Kingdom'],
  ['northern ireland', 'United Kingdom'],
  // USA
  ['usa', 'United States'],
  ['u.s.a.', 'United States'],
  ['us', 'United States'],
  ['u.s.', 'United States'],
  ['united states of america', 'United States'],
  ['america', 'United States'],
  // Netherlands
  ['holland', 'Netherlands'],
  ['the netherlands', 'Netherlands'],
  // South Korea
  ['south korea', 'South Korea'],
  ['korea', 'South Korea'],
  ['s. korea', 'South Korea'],
  // Czech Republic
  ['czechia', 'Czech Republic'],
  ['czech', 'Czech Republic'],
  // Russia
  ['russia', 'Russia'],
  ['russian federation', 'Russia'],
  // Turkey
  ['turkey', 'Turkey'],
  ['türkiye', 'Turkey'],
  // Ivory Coast
  ["côte d'ivoire", 'Ivory Coast'],
  ["cote d'ivoire", 'Ivory Coast'],
  // Cape Verde
  ['cabo verde', 'Cape Verde'],
  // Eswatini
  ['swaziland', 'Eswatini'],
  // DRC
  ['dr congo', 'Democratic Republic of the Congo'],
  ['drc', 'Democratic Republic of the Congo'],
  // Republic of Congo
  ['congo', 'Republic of the Congo'],
  ['roc', 'Republic of the Congo'],
  // North Macedonia
  ['macedonia', 'North Macedonia'],
  ['fyrom', 'North Macedonia'],
  // Burma (old name for Myanmar)
  ['burma', 'Myanmar'],
  // Vietnam
  ['viet nam', 'Vietnam'],
  // Laos
  ['lao pdr', 'Laos'],
  // Brunei
  ['brunei darussalam', 'Brunei'],
  // Timor-Leste
  ['east timor', 'Timor-Leste'],
  // Palestine
  ['palestinian territories', 'Palestine'],
  ['west bank', 'Palestine'],
  ['gaza', 'Palestine'],
  // Hong Kong / Macau
  ['hong kong', 'Hong Kong'],
  ['hongkong', 'Hong Kong'],
  ['macao', 'Macau'],
  // Vatican
  ['vatican', 'Vatican City'],
  ['holy see', 'Vatican City'],
  // Kosovo
  ['kosovo', 'Kosovo'],
  // Falkland Islands
  ['falklands', 'Falkland Islands'],
  // Bosnia
  ['bosnia', 'Bosnia and Herzegovina'],
  ['bosnia and herzegovina', 'Bosnia and Herzegovina'],
];

export const COUNTRY_ALIASES: ReadonlyMap<string, string> = new Map(
  ALIAS_ENTRIES.map(([alias, name]) => [alias.toLowerCase(), name]),
);

// ─── Lookup helpers ───────────────────────────────────────────────────────────

/** Find a CountryOption by canonical name (case-insensitive). */
export function findCountryByName(name: string): CountryOption | undefined {
  const lower = name.trim().toLowerCase();
  return COUNTRIES.find(c => c.name.toLowerCase() === lower);
}

/**
 * Canonicalize a country name or alias to the canonical country name.
 * Returns the canonical name, or null if the input doesn't match any known
 * country or alias.
 */
export function canonicalizeCountry(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  // Direct alias lookup
  const aliasResult = COUNTRY_ALIASES.get(lower);
  if (aliasResult) return aliasResult;

  // Direct canonical name match
  const country = COUNTRIES.find(c => c.name.toLowerCase() === lower);
  if (country) return country.name;

  return null;
}

/**
 * Search countries by name or dial code for the country selector dropdown.
 * Matches names case-insensitively and dial codes with or without the leading +.
 * Empty query returns all countries.
 */
export function searchCountries(query: string): CountryOption[] {
  const lower = query.trim().toLowerCase();
  if (!lower) return COUNTRIES;

  const matched = new Set<CountryOption>();

  for (const c of COUNTRIES) {
    if (c.name.toLowerCase().includes(lower) || c.dialCode.includes(lower)) {
      matched.add(c);
    }
  }

  for (const [alias, canonical] of COUNTRY_ALIASES) {
    if (alias.includes(lower)) {
      const country = COUNTRIES.find(c => c.name === canonical);
      if (country) matched.add(country);
    }
  }

  return COUNTRIES.filter(c => matched.has(c));
}

// ─── Sentinel ─────────────────────────────────────────────────────────────────

/** Sentinel value for unresolved country. Not a selectable country. */
export const UNSURE_COUNTRY = 'UNSURE';
