// Derives an Indian state name from a free-text address string.
// Returns the canonical state name if any known city, state name, or abbreviation
// is found. Returns "OUTSIDE INDIA" if the address is non-empty but unrecognized.
// Returns null if the address is blank.

// Each entry: [keywords to match (lowercase), canonical state name]
// Longer / more-specific patterns are checked before abbreviations so a match
// like "Andhra Pradesh" wins over a stray "AP" token.
const INDIA_MAP: [string[], string][] = [
  [
    ['andhra pradesh', 'visakhapatnam', 'vizag', 'vijayawada', 'guntur', 'tirupati',
     'kurnool', 'rajahmundry', 'kakinada', 'nellore', 'amaravati', 'ongole',
     'eluru', 'kadapa', 'anantapur', 'srikakulam'],
    'Andhra Pradesh',
  ],
  [
    ['arunachal pradesh', 'itanagar', 'naharlagun', 'pasighat'],
    'Arunachal Pradesh',
  ],
  [
    ['assam', 'guwahati', 'silchar', 'dibrugarh', 'jorhat', 'nagaon',
     'tinsukia', 'dispur', 'lakhimpur', 'bongaigaon'],
    'Assam',
  ],
  [
    ['bihar', 'patna', 'gaya', 'bhagalpur', 'muzaffarpur', 'purnia',
     'bihar sharif', 'darbhanga', 'arrah', 'bettiah', 'sasaram', 'hajipur'],
    'Bihar',
  ],
  [
    ['chhattisgarh', 'raipur', 'bhilai', 'bilaspur', 'korba', 'durg',
     'rajnandgaon', 'raigarh', 'ambikapur', 'jagdalpur'],
    'Chhattisgarh',
  ],
  [
    ['goa', 'panaji', 'margao', 'vasco', 'mapusa', 'panjim'],
    'Goa',
  ],
  [
    ['gujarat', 'ahmedabad', 'surat', 'vadodara', 'baroda', 'rajkot',
     'bhavnagar', 'jamnagar', 'gandhinagar', 'anand', 'nadiad', 'morbi',
     'junagadh', 'navsari', 'gandhidham', 'bharuch', 'mehsana', 'surendranagar',
     'porbandar', 'amreli', 'vapi', 'veraval'],
    'Gujarat',
  ],
  [
    ['haryana', 'faridabad', 'gurugram', 'gurgaon', 'panipat', 'ambala',
     'yamunanagar', 'rohtak', 'hisar', 'karnal', 'sonipat', 'bhiwani',
     'sirsa', 'jhajjar', 'rewari', 'panchkula', 'palwal'],
    'Haryana',
  ],
  [
    ['himachal pradesh', 'shimla', 'dharamshala', 'solan', 'mandi', 'palampur',
     'kullu', 'manali', 'baddi', 'hamirpur', 'bilaspur', 'una', 'kangra', 'chamba'],
    'Himachal Pradesh',
  ],
  [
    ['jharkhand', 'ranchi', 'jamshedpur', 'dhanbad', 'bokaro', 'deoghar',
     'hazaribagh', 'giridih', 'phusro', 'ramgarh', 'chaibasa'],
    'Jharkhand',
  ],
  [
    ['karnataka', 'bengaluru', 'bangalore', 'mysuru', 'mysore', 'hubballi',
     'hubli', 'mangaluru', 'mangalore', 'belagavi', 'belgaum', 'kalaburagi',
     'gulbarga', 'tumakuru', 'tumkur', 'davanagere', 'davangere', 'ballari',
     'bellary', 'shivamogga', 'shimoga', 'udupi', 'bidar', 'raichur',
     'dharwad', 'gadag', 'vijayapura', 'bijapur', 'hassan', 'mandya', 'chikkamagaluru'],
    'Karnataka',
  ],
  [
    ['kerala', 'thiruvananthapuram', 'trivandrum', 'kochi', 'cochin',
     'ernakulam', 'kozhikode', 'calicut', 'thrissur', 'trichur', 'kollam',
     'quilon', 'alappuzha', 'alleppey', 'palakkad', 'malappuram', 'kannur',
     'kasaragod', 'kottayam', 'idukki', 'wayanad', 'pathanamthitta'],
    'Kerala',
  ],
  [
    ['madhya pradesh', 'bhopal', 'indore', 'gwalior', 'jabalpur', 'ujjain',
     'sagar', 'dewas', 'satna', 'ratlam', 'rewa', 'murwara', 'katni',
     'singrauli', 'chhindwara', 'guna', 'shivpuri', 'vidisha', 'damoh',
     'mandsaur', 'khandwa', 'burhanpur', 'itarsi', 'sehore'],
    'Madhya Pradesh',
  ],
  [
    ['maharashtra', 'mumbai', 'bombay', 'pune', 'nagpur', 'thane', 'nashik',
     'aurangabad', 'solapur', 'amravati', 'navi mumbai', 'kolhapur', 'sangli',
     'malegaon', 'jalgaon', 'akola', 'latur', 'dhule', 'ahmednagar',
     'chandrapur', 'parbhani', 'ichalkaranji', 'jalna', 'bhiwandi', 'panvel',
     'vasai', 'ulhasnagar', 'nandurbar', 'beed', 'osmanabad', 'hingoli',
     'wardha', 'yavatmal', 'buldhana', 'washim', 'gadchiroli', 'gondia',
     'bhandara', 'raigad', 'ratnagiri', 'sindhudurg', 'satara', 'baramati'],
    'Maharashtra',
  ],
  [
    ['manipur', 'imphal', 'churachandpur', 'thoubal', 'bishnupur'],
    'Manipur',
  ],
  [
    ['meghalaya', 'shillong', 'tura', 'nongpoh', 'jowai'],
    'Meghalaya',
  ],
  [
    ['mizoram', 'aizawl', 'lunglei', 'saiha', 'champhai'],
    'Mizoram',
  ],
  [
    ['nagaland', 'kohima', 'dimapur', 'mokokchung', 'wokha'],
    'Nagaland',
  ],
  [
    ['odisha', 'orissa', 'bhubaneswar', 'cuttack', 'rourkela', 'brahmapur',
     'berhampur', 'sambalpur', 'puri', 'balasore', 'bhadrak', 'baripada',
     'jharsuguda', 'bargarh', 'jeypore'],
    'Odisha',
  ],
  [
    ['punjab', 'ludhiana', 'amritsar', 'jalandhar', 'patiala', 'bathinda',
     'mohali', 'pathankot', 'hoshiarpur', 'moga', 'firozpur', 'sangrur',
     'barnala', 'fatehgarh sahib', 'rupnagar', 'ropar'],
    'Punjab',
  ],
  [
    ['rajasthan', 'jaipur', 'jodhpur', 'kota', 'bikaner', 'ajmer', 'udaipur',
     'bhilwara', 'alwar', 'bharatpur', 'sikar', 'nagaur', 'pali', 'tonk',
     'chittorgarh', 'jhunjhunu', 'churu', 'sri ganganagar', 'ganganagar',
     'hanumangarh', 'bundi', 'banswara', 'barmer', 'jaisalmer', 'sawai madhopur'],
    'Rajasthan',
  ],
  [
    ['sikkim', 'gangtok', 'namchi', 'gyalshing', 'mangan'],
    'Sikkim',
  ],
  [
    ['tamil nadu', 'tamilnadu', 'chennai', 'madras', 'coimbatore', 'madurai',
     'tiruchirappalli', 'trichy', 'salem', 'tirunelveli', 'tiruppur',
     'vellore', 'erode', 'thoothukudi', 'tuticorin', 'dindigul', 'thanjavur',
     'ranipet', 'nagercoil', 'karur', 'cuddalore', 'kumbakonam', 'hosur',
     'kancheepuram', 'sivakasi', 'vilupuram'],
    'Tamil Nadu',
  ],
  [
    ['telangana', 'hyderabad', 'warangal', 'nizamabad', 'khammam',
     'karimnagar', 'ramagundam', 'secunderabad', 'nalgonda', 'mahbubnagar',
     'adilabad', 'siddipet', 'suryapet'],
    'Telangana',
  ],
  [
    ['tripura', 'agartala', 'dharmanagar', 'udaipur', 'kailasahar', 'ambassa'],
    'Tripura',
  ],
  [
    ['uttar pradesh', 'lucknow', 'kanpur', 'ghaziabad', 'agra', 'varanasi',
     'meerut', 'allahabad', 'prayagraj', 'bareilly', 'aligarh', 'moradabad',
     'saharanpur', 'noida', 'greater noida', 'mathura', 'jhansi', 'gorakhpur',
     'firozabad', 'muzaffarnagar', 'hapur', 'etawah', 'rampur', 'shahjahanpur',
     'bulandshahr', 'sambhal', 'amroha', 'bijnor', 'hardoi', 'ayodhya',
     'faizabad', 'lakhimpur kheri', 'sitapur', 'barabanki', 'unnao',
     'rae bareli', 'sultanpur', 'jaunpur', 'azamgarh', 'mirzapur', 'basti'],
    'Uttar Pradesh',
  ],
  [
    ['uttarakhand', 'uttaranchal', 'dehradun', 'haridwar', 'roorkee',
     'rishikesh', 'kashipur', 'haldwani', 'rudrapur', 'nainital', 'almora',
     'pithoragarh', 'mussoorie', 'kotdwar'],
    'Uttarakhand',
  ],
  [
    ['west bengal', 'kolkata', 'calcutta', 'howrah', 'durgapur', 'asansol',
     'siliguri', 'bardhaman', 'burdwan', 'malda', 'baharampur', 'krishnanagar',
     'haldia', 'kharagpur', 'bankura', 'purulia', 'jalpaiguri', 'cooch behar',
     'north 24 parganas', 'south 24 parganas'],
    'West Bengal',
  ],
  // Union Territories
  [
    ['delhi', 'new delhi', 'ncr', 'dwarka', 'rohini', 'pitampura', 'janakpuri',
     'lajpat nagar', 'karol bagh', 'connaught place', 'cp ', 'saket', 'nehru place',
     'vasant kunj', 'mayur vihar', 'preet vihar', 'shahdara', 'dilshad garden',
     'uttam nagar', 'najafgarh', 'narela', 'bawana'],
    'Delhi',
  ],
  [
    ['chandigarh', 'sector 17', 'sector 22', 'sector 35', 'sector 43', 'mohali', 'panchkula'],
    'Chandigarh',
  ],
  [
    ['jammu', 'srinagar', 'kashmir', 'anantnag', 'baramulla', 'sopore',
     'kathua', 'udhampur', 'rajouri'],
    'Jammu & Kashmir',
  ],
  [
    ['leh', 'ladakh', 'kargil'],
    'Ladakh',
  ],
  [
    ['puducherry', 'pondicherry', 'karaikal', 'mahe', 'yanam'],
    'Puducherry',
  ],
  [
    ['andaman', 'nicobar', 'port blair'],
    'Andaman & Nicobar Islands',
  ],
  [
    ['dadra', 'nagar haveli', 'silvassa', 'daman', 'diu'],
    'Dadra & Nagar Haveli and Daman & Diu',
  ],
  [
    ['lakshadweep', 'kavaratti'],
    'Lakshadweep',
  ],
];

// Abbreviation → state (checked only as whole tokens to prevent false positives)
const ABBREV_MAP: [string, string][] = [
  ['AP',  'Andhra Pradesh'],
  ['AR',  'Arunachal Pradesh'],
  ['AS',  'Assam'],
  ['BR',  'Bihar'],
  ['CG',  'Chhattisgarh'],
  ['CT',  'Chhattisgarh'],
  ['GA',  'Goa'],
  ['GJ',  'Gujarat'],
  ['HR',  'Haryana'],
  ['HP',  'Himachal Pradesh'],
  ['JH',  'Jharkhand'],
  ['KA',  'Karnataka'],
  ['KL',  'Kerala'],
  ['MP',  'Madhya Pradesh'],
  ['MH',  'Maharashtra'],
  ['MN',  'Manipur'],
  ['ML',  'Meghalaya'],
  ['MZ',  'Mizoram'],
  ['NL',  'Nagaland'],
  ['OD',  'Odisha'],
  ['OR',  'Odisha'],
  ['PB',  'Punjab'],
  ['RJ',  'Rajasthan'],
  ['SK',  'Sikkim'],
  ['TN',  'Tamil Nadu'],
  ['TS',  'Telangana'],
  ['TG',  'Telangana'],
  ['TR',  'Tripura'],
  ['UP',  'Uttar Pradesh'],
  ['UK',  'Uttarakhand'],
  ['UT',  'Uttarakhand'],
  ['WB',  'West Bengal'],
  ['DL',  'Delhi'],
  ['CH',  'Chandigarh'],
  ['JK',  'Jammu & Kashmir'],
  ['LA',  'Ladakh'],
  ['PY',  'Puducherry'],
];

// Compile abbreviation regexes once
const ABBREV_PATTERNS: [RegExp, string][] = ABBREV_MAP.map(([abbrev, state]) => [
  new RegExp(`(?:^|[^a-z0-9])${abbrev}(?:$|[^a-z0-9])`, 'i'),
  state,
]);

export function deriveState(address: string): string | null {
  const a = address.trim();
  if (!a) return null;

  const lower = a.toLowerCase();

  // 1. Check full state/city names (most specific)
  for (const [patterns, state] of INDIA_MAP) {
    for (const p of patterns) {
      if (lower.includes(p)) return state;
    }
  }

  // 2. Check state abbreviations as isolated tokens
  for (const [re, state] of ABBREV_PATTERNS) {
    if (re.test(a)) return state;
  }

  return 'OUTSIDE INDIA';
}
