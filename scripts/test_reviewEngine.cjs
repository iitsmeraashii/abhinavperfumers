// src/runtime/runtimeConfiguration.ts
var DEFAULT_REVIEW_CONFIG = {
  minimumConfidence: 75
};
var _reviewCache = null;
function getCachedReviewConfig() {
  return _reviewCache ?? { ...DEFAULT_REVIEW_CONFIG };
}

// src/runtime/runtimeDiagnostics.ts
function getReviewMinimumConfidence() {
  return getCachedReviewConfig().minimumConfidence;
}

// src/capture/captureReviewEngine.ts
var FALLBACK_MINIMUM_CONFIDENCE = 75;
var PLACEHOLDER_PATTERNS = /^(n\/?a|none|null|undefined|unknown|\.+|-+|test|xxx|example\..*|sample)$/i;
var MASKED_PATTERNS = /x{2,}|\*{2,}|\?{2,}|_{2,}/i;
function isMeaningful(value) {
  if (!value) return false;
  const trimmed = String(value).trim();
  if (!trimmed) return false;
  if (PLACEHOLDER_PATTERNS.test(trimmed)) return false;
  return true;
}
function phoneDigits(phone) {
  return phone.replace(/\D/g, "");
}
function validatePhone(phone, index) {
  const trimmed = phone.trim();
  if (!trimmed) return null;
  if (MASKED_PATTERNS.test(trimmed)) {
    return { field: "phoneNumbers", value: phone, index, reason: "INVALID_PHONE" /* INVALID_PHONE */, detail: "Contains masked or obscured characters" };
  }
  if (PLACEHOLDER_PATTERNS.test(trimmed)) {
    return { field: "phoneNumbers", value: phone, index, reason: "INVALID_PHONE" /* INVALID_PHONE */, detail: "Placeholder value" };
  }
  const digits = phoneDigits(trimmed);
  if (digits.startsWith("91")) {
    const mobilePart = digits.slice(2);
    if (mobilePart.length < 10) {
      return { field: "phoneNumbers", value: phone, index, reason: "INVALID_PHONE" /* INVALID_PHONE */, detail: `Incomplete Indian number: only ${mobilePart.length} digits after country code (expected 10)` };
    }
    if (mobilePart.length === 10 && !/^[6-9]/.test(mobilePart)) {
      return { field: "phoneNumbers", value: phone, index, reason: "INVALID_PHONE" /* INVALID_PHONE */, detail: "Indian mobile number should start with 6, 7, 8, or 9" };
    }
    return null;
  }
  if (digits.length === 10 && /^[6-9]/.test(digits)) {
    return null;
  }
  if (digits.length < 7) {
    return { field: "phoneNumbers", value: phone, index, reason: "INVALID_PHONE" /* INVALID_PHONE */, detail: `Too short: only ${digits.length} digits` };
  }
  if (digits.length > 15) {
    return { field: "phoneNumbers", value: phone, index, reason: "INVALID_PHONE" /* INVALID_PHONE */, detail: `Too long: ${digits.length} digits (max 15 per ITU-T E.164)` };
  }
  return null;
}
function validateEmail(email, index) {
  const trimmed = email.trim();
  if (!trimmed) return null;
  if (/\s/.test(trimmed)) {
    return { field: "emails", value: email, index, reason: "INVALID_EMAIL" /* INVALID_EMAIL */, detail: "Contains whitespace" };
  }
  if (MASKED_PATTERNS.test(trimmed)) {
    return { field: "emails", value: email, index, reason: "INVALID_EMAIL" /* INVALID_EMAIL */, detail: "Contains masked or obscured characters" };
  }
  const atCount = (trimmed.match(/@/g) ?? []).length;
  if (atCount !== 1) {
    return { field: "emails", value: email, index, reason: "INVALID_EMAIL" /* INVALID_EMAIL */, detail: atCount === 0 ? "Missing @ symbol" : "Multiple @ symbols" };
  }
  const [local, domain] = trimmed.split("@");
  if (!local || local.length < 1) {
    return { field: "emails", value: email, index, reason: "INVALID_EMAIL" /* INVALID_EMAIL */, detail: "Empty local part (before @)" };
  }
  if (!domain || domain.length < 1) {
    return { field: "emails", value: email, index, reason: "INVALID_EMAIL" /* INVALID_EMAIL */, detail: "Empty domain (after @)" };
  }
  if (!domain.includes(".")) {
    return { field: "emails", value: email, index, reason: "INVALID_EMAIL" /* INVALID_EMAIL */, detail: 'Domain missing dot (e.g. "company" instead of "company.com")' };
  }
  if (PLACEHOLDER_PATTERNS.test(local) || PLACEHOLDER_PATTERNS.test(domain)) {
    return { field: "emails", value: email, index, reason: "INVALID_EMAIL" /* INVALID_EMAIL */, detail: "Placeholder value in local or domain" };
  }
  if (domain.startsWith(".") || domain.endsWith(".")) {
    return { field: "emails", value: email, index, reason: "INVALID_EMAIL" /* INVALID_EMAIL */, detail: "Malformed domain (starts or ends with dot)" };
  }
  return null;
}
function validateWebsite(website) {
  const trimmed = website.trim();
  if (!trimmed) return null;
  if (/\s/.test(trimmed)) {
    return { field: "website", value: website, reason: "INVALID_WEBSITE" /* INVALID_WEBSITE */, detail: "Contains whitespace" };
  }
  if (MASKED_PATTERNS.test(trimmed)) {
    return { field: "website", value: website, reason: "INVALID_WEBSITE" /* INVALID_WEBSITE */, detail: "Contains masked or obscured characters" };
  }
  if (PLACEHOLDER_PATTERNS.test(trimmed)) {
    return { field: "website", value: website, reason: "INVALID_WEBSITE" /* INVALID_WEBSITE */, detail: "Placeholder value" };
  }
  const withoutProtocol = trimmed.replace(/^https?:\/\//i, "");
  if (!withoutProtocol.includes(".")) {
    return { field: "website", value: website, reason: "INVALID_WEBSITE" /* INVALID_WEBSITE */, detail: 'Domain missing dot (e.g. "company" instead of "company.com")' };
  }
  if (withoutProtocol.startsWith(".") || withoutProtocol.endsWith(".")) {
    return { field: "website", value: website, reason: "INVALID_WEBSITE" /* INVALID_WEBSITE */, detail: "Malformed domain (starts or ends with dot)" };
  }
  return null;
}
function findContactValidationViolations(data) {
  const violations = [];
  const checkedPhoneIndices = /* @__PURE__ */ new Set();
  if (Array.isArray(data.phoneNumbers)) {
    for (let i = 0; i < data.phoneNumbers.length; i++) {
      const v = String(data.phoneNumbers[i] ?? "").trim();
      if (!isMeaningful(v)) continue;
      const violation = validatePhone(v, i);
      if (violation) violations.push(violation);
      checkedPhoneIndices.add(i);
    }
  }
  if (isMeaningful(data.phone) && (!Array.isArray(data.phoneNumbers) || !checkedPhoneIndices.has(0))) {
    const violation = validatePhone(data.phone, 0);
    if (violation) violations.push(violation);
  }
  const checkedEmailIndices = /* @__PURE__ */ new Set();
  if (Array.isArray(data.emails)) {
    for (let i = 0; i < data.emails.length; i++) {
      const v = String(data.emails[i] ?? "").trim();
      if (!isMeaningful(v)) continue;
      const violation = validateEmail(v, i);
      if (violation) violations.push(violation);
      checkedEmailIndices.add(i);
    }
  }
  if (isMeaningful(data.email) && (!Array.isArray(data.emails) || !checkedEmailIndices.has(0))) {
    const violation = validateEmail(data.email, 0);
    if (violation) violations.push(violation);
  }
  if (isMeaningful(data.website)) {
    const violation = validateWebsite(data.website);
    if (violation) violations.push(violation);
  }
  return violations;
}
function isSuspiciousEmail(email) {
  const trimmed = email.trim();
  if (!trimmed) return false;
  const atCount = (trimmed.match(/@/g) ?? []).length;
  if (atCount !== 1) return true;
  const [local, domain] = trimmed.split("@");
  if (!local || local.length < 1) return true;
  if (!domain || !domain.includes(".")) return true;
  if (PLACEHOLDER_PATTERNS.test(local) || PLACEHOLDER_PATTERNS.test(domain)) return true;
  return false;
}
function isSuspiciousPhone(phone) {
  const trimmed = phone.trim();
  if (!trimmed) return false;
  const digits = trimmed.replace(/[\s\-().+#]/g, "");
  if (digits.length < 7) return true;
  if (PLACEHOLDER_PATTERNS.test(trimmed)) return true;
  return false;
}
function isSuspiciousWebsite(website) {
  const trimmed = website.trim();
  if (!trimmed) return false;
  if (PLACEHOLDER_PATTERNS.test(trimmed)) return true;
  if (!trimmed.includes(".")) return true;
  return false;
}
function countMeaningfulFields(d) {
  let count = 0;
  if (isMeaningful(d.clientName)) count++;
  if (isMeaningful(d.company)) count++;
  if (isMeaningful(d.designation)) count++;
  if (isMeaningful(d.phone) || Array.isArray(d.phoneNumbers) && d.phoneNumbers.some((p) => isMeaningful(p))) count++;
  if (isMeaningful(d.email) || Array.isArray(d.emails) && d.emails.some((e) => isMeaningful(e))) count++;
  if (isMeaningful(d.website)) count++;
  if (isMeaningful(d.address)) count++;
  return count;
}
function findSuspiciousContact(d) {
  const emails = [];
  if (isMeaningful(d.email)) emails.push(d.email);
  if (Array.isArray(d.emails)) {
    for (const e of d.emails) if (isMeaningful(e)) emails.push(e);
  }
  for (const e of emails) if (isSuspiciousEmail(e)) return "email";
  const phones = [];
  if (isMeaningful(d.phone)) phones.push(d.phone);
  if (Array.isArray(d.phoneNumbers)) {
    for (const p of d.phoneNumbers) if (isMeaningful(p)) phones.push(p);
  }
  for (const p of phones) if (isSuspiciousPhone(p)) return "phone";
  if (isMeaningful(d.website) && isSuspiciousWebsite(d.website)) return "website";
  return null;
}
var SCALAR_FIELD_MAP = [
  { fcKey: "fullName", draftKey: "clientName" },
  { fcKey: "company", draftKey: "company" },
  { fcKey: "designation", draftKey: "designation" },
  { fcKey: "website", draftKey: "website" },
  { fcKey: "address", draftKey: "address" }
];
function findFieldConfidenceViolations(data, fc, thresholdPercent) {
  if (!fc) return [];
  const threshold = thresholdPercent / 100;
  const violations = [];
  for (const { fcKey, draftKey } of SCALAR_FIELD_MAP) {
    const score = fc[fcKey];
    if (typeof score !== "number") continue;
    const value = String(data[draftKey] ?? "").trim();
    if (!isMeaningful(value)) continue;
    if (score <= threshold) {
      violations.push({ field: fcKey, value, score });
    }
  }
  if (Array.isArray(fc.phoneNumbers) && Array.isArray(data.phoneNumbers)) {
    for (let i = 0; i < data.phoneNumbers.length; i++) {
      const score = fc.phoneNumbers[i];
      if (typeof score !== "number") continue;
      const value = String(data.phoneNumbers[i] ?? "").trim();
      if (!isMeaningful(value)) continue;
      if (score <= threshold) {
        violations.push({ field: "phoneNumbers", value, index: i, score });
      }
    }
  }
  if (Array.isArray(fc.emails) && Array.isArray(data.emails)) {
    for (let i = 0; i < data.emails.length; i++) {
      const score = fc.emails[i];
      if (typeof score !== "number") continue;
      const value = String(data.emails[i] ?? "").trim();
      if (!isMeaningful(value)) continue;
      if (score <= threshold) {
        violations.push({ field: "emails", value, index: i, score });
      }
    }
  }
  return violations;
}
var STATUS_SCALAR_FIELD_MAP = [
  { fsKey: "fullName", draftKey: "clientName" },
  { fsKey: "company", draftKey: "company" },
  { fsKey: "designation", draftKey: "designation" },
  { fsKey: "website", draftKey: "website" },
  { fsKey: "address", draftKey: "address" }
];
function findFieldStatusViolations(data, fs) {
  if (!fs) return [];
  const violations = [];
  for (const { fsKey, draftKey } of STATUS_SCALAR_FIELD_MAP) {
    const status = fs[fsKey];
    if (status !== "uncertain") continue;
    const value = String(data[draftKey] ?? "").trim() || null;
    violations.push({ field: fsKey, status: "uncertain", value });
  }
  if (Array.isArray(fs.phoneNumbers)) {
    for (let i = 0; i < fs.phoneNumbers.length; i++) {
      if (fs.phoneNumbers[i] !== "uncertain") continue;
      const value = Array.isArray(data.phoneNumbers) ? String(data.phoneNumbers[i] ?? "").trim() || null : null;
      violations.push({ field: "phoneNumbers", index: i, status: "uncertain", value });
    }
  }
  if (Array.isArray(fs.emails)) {
    for (let i = 0; i < fs.emails.length; i++) {
      if (fs.emails[i] !== "uncertain") continue;
      const value = Array.isArray(data.emails) ? String(data.emails[i] ?? "").trim() || null : null;
      violations.push({ field: "emails", index: i, status: "uncertain", value });
    }
  }
  return violations;
}
var CaptureReviewEngine = class {
  /**
   * Return the current minimum confidence threshold (0–100).
   * Reads from the in-memory runtime configuration cache — O(1), no DB call.
   * Falls back to 75 when the cache has not been populated yet.
   */
  get minimumConfidence() {
    const configured = getReviewMinimumConfidence();
    return Number.isFinite(configured) ? configured : FALLBACK_MINIMUM_CONFIDENCE;
  }
  /**
   * Evaluate review rules for a capture session.
   *
   * All applicable rules are evaluated — the result retains the full list of
   * triggered reasons in {@link ReviewResult.reasons}. The {@link ReviewResult.reason}
   * field holds the first triggered reason for backward compatibility.
   *
   * Rule evaluation order:
   *   1. QR_NO_EXTRACTION        (terminal — returns immediately)
   *   2. EXTRACTION_FAILED       (terminal — returns immediately)
   *   3. null-confidence guard   (manual entry — returns immediately, no review)
   *   4. LOW_CONFIDENCE
   *   5. LOW_FIELD_CONFIDENCE
   *   6. INSUFFICIENT_EXTRACTION
   *   7. SUSPICIOUS_CONTACT      (legacy heuristic)
   *   8. INVALID_PHONE           (deterministic)
   *   9. INVALID_EMAIL           (deterministic)
   *  10. INVALID_WEBSITE         (deterministic)
   *
   * @param data                 Full DraftData — needed for all field-level rules.
   * @param extractionConfidence AI extraction confidence on a 0–100 scale,
   *                             or null if no AI extraction occurred.
   * @param extraction           Extraction lifecycle context (status, fieldConfidence),
   *                             or undefined if called from a context that doesn't track it.
   * @returns ReviewResult — always non-null; required=false when no rule fires.
   */
  evaluate(data, extractionConfidence, extraction) {
    const reasons = [];
    let fieldConfidenceViolations;
    let contactViolations;
    if (data.qrExtractionEmpty) {
      reasons.push("QR_NO_EXTRACTION" /* QR_NO_EXTRACTION */);
      return {
        required: true,
        reason: reasons[0],
        reasons,
        confidence: null
      };
    }
    if (extraction?.status === "failed") {
      reasons.push("EXTRACTION_FAILED" /* EXTRACTION_FAILED */);
      return {
        required: true,
        reason: reasons[0],
        reasons,
        confidence: extractionConfidence
      };
    }
    if (extractionConfidence === null) {
      return { required: false, reason: null, reasons: [], confidence: null };
    }
    if (extractionConfidence <= this.minimumConfidence) {
      reasons.push("LOW_CONFIDENCE" /* LOW_CONFIDENCE */);
    }
    const fcViolations = findFieldConfidenceViolations(
      data,
      extraction?.fieldConfidence,
      this.minimumConfidence
    );
    if (fcViolations.length > 0) {
      reasons.push("LOW_FIELD_CONFIDENCE" /* LOW_FIELD_CONFIDENCE */);
      fieldConfidenceViolations = fcViolations;
    }
    if (countMeaningfulFields(data) <= 1) {
      reasons.push("INSUFFICIENT_EXTRACTION" /* INSUFFICIENT_EXTRACTION */);
    }
    const suspiciousField = findSuspiciousContact(data);
    if (suspiciousField) {
      reasons.push("SUSPICIOUS_CONTACT" /* SUSPICIOUS_CONTACT */);
    }
    const detViolations = findContactValidationViolations(data);
    if (detViolations.length > 0) {
      contactViolations = detViolations;
      const seen = /* @__PURE__ */ new Set();
      for (const v of detViolations) {
        if (!seen.has(v.reason)) {
          reasons.push(v.reason);
          seen.add(v.reason);
        }
      }
    }
    const fsViolations = findFieldStatusViolations(data, extraction?.fieldStatus);
    if (fsViolations.length > 0) {
      reasons.push("UNCERTAIN_FIELD" /* UNCERTAIN_FIELD */);
    }
    if (reasons.length > 0) {
      return {
        required: true,
        reason: reasons[0],
        reasons,
        confidence: extractionConfidence,
        fieldConfidenceViolations,
        contactViolations,
        fieldStatusViolations: fsViolations.length > 0 ? fsViolations : void 0
      };
    }
    return { required: false, reason: null, reasons: [], confidence: extractionConfidence };
  }
};
var reviewEngine = new CaptureReviewEngine();

// scripts/test_reviewEngine.ts
var passed = 0;
var failed = 0;
function makeDraft(overrides = {}) {
  return {
    clientName: "",
    company: "",
    designation: "",
    phone: "",
    email: "",
    website: "",
    address: "",
    phoneNumbers: [],
    emails: [],
    notes: "",
    ...overrides
  };
}
function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}
console.log('\nTEST 1: overall 95%, phone "+9198344", phone confidence 0.85');
{
  const data = makeDraft({
    clientName: "Rahul Sharma",
    company: "Tech Corp",
    phoneNumbers: ["+9198344"]
  });
  const fc = { phoneNumbers: [0.85], fullName: 0.95, company: 0.95 };
  const ctx = { status: "done", fieldConfidence: fc };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(result.required, "TEST 1 \u2014 required = true");
  assert(result.reasons.includes("INVALID_PHONE" /* INVALID_PHONE */), "TEST 1 \u2014 includes INVALID_PHONE");
  assert(!!result.contactViolations, "TEST 1 \u2014 has contactViolations");
  if (result.contactViolations) {
    assert(result.contactViolations[0]?.field === "phoneNumbers", "TEST 1 \u2014 violation field = phoneNumbers");
    assert(result.contactViolations[0]?.index === 0, "TEST 1 \u2014 violation index = 0");
    assert(result.contactViolations[0]?.value === "+9198344", "TEST 1 \u2014 violation value = +9198344");
  }
}
console.log("\nTEST 2: overall 95%, valid Indian mobile, phone confidence 0.85");
{
  const data = makeDraft({
    clientName: "Rahul Sharma",
    company: "Tech Corp",
    phoneNumbers: ["+919876543210"]
  });
  const fc = { phoneNumbers: [0.85], fullName: 0.95, company: 0.95 };
  const ctx = { status: "done", fieldConfidence: fc };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(!result.required, "TEST 2 \u2014 required = false (no review)");
  assert(result.reasons.length === 0, "TEST 2 \u2014 no reasons");
}
console.log("\nTEST 3: overall 95%, valid phone, phone confidence 0.60");
{
  const data = makeDraft({
    clientName: "Rahul Sharma",
    company: "Tech Corp",
    phoneNumbers: ["+919876543210"]
  });
  const fc = { phoneNumbers: [0.6], fullName: 0.95, company: 0.95 };
  const ctx = { status: "done", fieldConfidence: fc };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(result.required, "TEST 3 \u2014 required = true");
  assert(result.reasons.includes("LOW_FIELD_CONFIDENCE" /* LOW_FIELD_CONFIDENCE */), "TEST 3 \u2014 includes LOW_FIELD_CONFIDENCE");
  assert(!result.reasons.includes("INVALID_PHONE" /* INVALID_PHONE */), "TEST 3 \u2014 does NOT include INVALID_PHONE");
}
console.log('\nTEST 4: overall 95%, email "rahul@company", email confidence 0.95');
{
  const data = makeDraft({
    clientName: "Rahul Sharma",
    company: "Tech Corp",
    emails: ["rahul@company"]
  });
  const fc = { emails: [0.95], fullName: 0.95, company: 0.95 };
  const ctx = { status: "done", fieldConfidence: fc };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(result.required, "TEST 4 \u2014 required = true");
  assert(result.reasons.includes("INVALID_EMAIL" /* INVALID_EMAIL */), "TEST 4 \u2014 includes INVALID_EMAIL");
}
console.log('\nTEST 5: overall 95%, website "company", website confidence 0.95');
{
  const data = makeDraft({
    clientName: "Rahul Sharma",
    company: "Tech Corp",
    website: "company"
  });
  const fc = { website: 0.95, fullName: 0.95, company: 0.95 };
  const ctx = { status: "done", fieldConfidence: fc };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(result.required, "TEST 5 \u2014 required = true");
  assert(result.reasons.includes("INVALID_WEBSITE" /* INVALID_WEBSITE */), "TEST 5 \u2014 includes INVALID_WEBSITE");
}
console.log("\nTEST 6: overall 70%, all valid, field confidence > 0.75");
{
  const data = makeDraft({
    clientName: "Rahul Sharma",
    company: "Tech Corp",
    phoneNumbers: ["+919876543210"],
    emails: ["rahul@techcorp.com"],
    website: "techcorp.com"
  });
  const fc = {
    fullName: 0.95,
    company: 0.95,
    phoneNumbers: [0.9],
    emails: [0.9],
    website: 0.9
  };
  const ctx = { status: "done", fieldConfidence: fc };
  const result = reviewEngine.evaluate(data, 70, ctx);
  assert(result.required, "TEST 6 \u2014 required = true");
  assert(result.reasons.includes("LOW_CONFIDENCE" /* LOW_CONFIDENCE */), "TEST 6 \u2014 includes LOW_CONFIDENCE");
}
console.log("\nTEST 7: overall 95%, phone invalid, phone confidence 0.90");
{
  const data = makeDraft({
    clientName: "Rahul Sharma",
    company: "Tech Corp",
    phoneNumbers: ["+9198344"]
  });
  const fc = { phoneNumbers: [0.9], fullName: 0.95, company: 0.95 };
  const ctx = { status: "done", fieldConfidence: fc };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(result.required, "TEST 7 \u2014 required = true");
  assert(result.reasons.includes("INVALID_PHONE" /* INVALID_PHONE */), "TEST 7 \u2014 includes INVALID_PHONE");
  assert(!result.reasons.includes("LOW_FIELD_CONFIDENCE" /* LOW_FIELD_CONFIDENCE */), "TEST 7 \u2014 does NOT include LOW_FIELD_CONFIDENCE (0.90 > 0.75)");
}
console.log("\nTEST 8: manual entry, extractionConfidence = null");
{
  const data = makeDraft({
    clientName: "Rahul Sharma",
    company: "Tech Corp",
    phoneNumbers: ["+9198344"]
    // invalid phone, but manual entry
  });
  const ctx = { status: null, fieldConfidence: void 0 };
  const result = reviewEngine.evaluate(data, null, ctx);
  assert(!result.required, "TEST 8 \u2014 required = false (manual entry, no review)");
  assert(result.reasons.length === 0, "TEST 8 \u2014 no reasons");
}
console.log("\nTEST 9: two phones, phone[0] valid, phone[1] invalid");
{
  const data = makeDraft({
    clientName: "Rahul Sharma",
    company: "Tech Corp",
    phoneNumbers: ["+919876543210", "+9198344"]
  });
  const fc = { phoneNumbers: [0.9, 0.85], fullName: 0.95, company: 0.95 };
  const ctx = { status: "done", fieldConfidence: fc };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(result.required, "TEST 9 \u2014 required = true");
  assert(result.reasons.includes("INVALID_PHONE" /* INVALID_PHONE */), "TEST 9 \u2014 includes INVALID_PHONE");
  if (result.contactViolations) {
    const phoneViolations = result.contactViolations.filter((v) => v.field === "phoneNumbers");
    assert(phoneViolations.length === 1, "TEST 9 \u2014 exactly 1 phone violation");
    assert(phoneViolations[0]?.index === 1, "TEST 9 \u2014 violation index = 1");
    assert(phoneViolations[0]?.value === "+9198344", "TEST 9 \u2014 violation value = +9198344");
  } else {
    assert(false, "TEST 9 \u2014 contactViolations missing");
  }
}
console.log('\nTEST A: overall 95%, phoneNumbers=[], fieldStatus.phoneNumbers=["uncertain"]');
{
  const data = makeDraft({
    clientName: "Rahul Sharma",
    company: "Tech Corp",
    emails: ["rahul@techcorp.com"],
    website: "techcorp.com",
    phoneNumbers: []
  });
  const fs = { phoneNumbers: ["uncertain"] };
  const ctx = { status: "done", fieldStatus: fs };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(result.required, "TEST A \u2014 required = true");
  assert(result.reasons.includes("UNCERTAIN_FIELD" /* UNCERTAIN_FIELD */), "TEST A \u2014 includes UNCERTAIN_FIELD");
  assert(!!result.fieldStatusViolations, "TEST A \u2014 has fieldStatusViolations");
  if (result.fieldStatusViolations) {
    assert(result.fieldStatusViolations[0]?.field === "phoneNumbers", "TEST A \u2014 violation field = phoneNumbers");
    assert(result.fieldStatusViolations[0]?.index === 0, "TEST A \u2014 violation index = 0");
    assert(result.fieldStatusViolations[0]?.value === null, "TEST A \u2014 violation value = null");
  }
}
console.log('\nTEST B: overall 95%, phoneNumbers=[], fieldStatus.phoneNumbers=["absent"]');
{
  const data = makeDraft({
    clientName: "Rahul Sharma",
    company: "Tech Corp",
    emails: ["rahul@techcorp.com"],
    website: "techcorp.com",
    phoneNumbers: []
  });
  const fs = { phoneNumbers: ["absent"] };
  const ctx = { status: "done", fieldStatus: fs };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(!result.required, "TEST B \u2014 required = false (absent phone, no review)");
  assert(!result.reasons.includes("UNCERTAIN_FIELD" /* UNCERTAIN_FIELD */), "TEST B \u2014 does NOT include UNCERTAIN_FIELD");
}
console.log('\nTEST C: overall 95%, phone "+9198344", phone confidence 0.85');
{
  const data = makeDraft({
    clientName: "Rahul Sharma",
    company: "Tech Corp",
    phoneNumbers: ["+9198344"]
  });
  const fc = { phoneNumbers: [0.85], fullName: 0.95, company: 0.95 };
  const ctx = { status: "done", fieldConfidence: fc };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(result.required, "TEST C \u2014 required = true");
  assert(result.reasons.includes("INVALID_PHONE" /* INVALID_PHONE */), "TEST C \u2014 includes INVALID_PHONE");
}
console.log("\nTEST D: overall 95%, valid phone, phone confidence 0.60");
{
  const data = makeDraft({
    clientName: "Rahul Sharma",
    company: "Tech Corp",
    phoneNumbers: ["+919834412345"]
  });
  const fc = { phoneNumbers: [0.6], fullName: 0.95, company: 0.95 };
  const ctx = { status: "done", fieldConfidence: fc };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(result.required, "TEST D \u2014 required = true");
  assert(result.reasons.includes("LOW_FIELD_CONFIDENCE" /* LOW_FIELD_CONFIDENCE */), "TEST D \u2014 includes LOW_FIELD_CONFIDENCE");
}
console.log("\nTEST E: overall 60%, all fields valid");
{
  const data = makeDraft({
    clientName: "Rahul Sharma",
    company: "Tech Corp",
    phoneNumbers: ["+919876543210"],
    emails: ["rahul@techcorp.com"],
    website: "techcorp.com"
  });
  const fc = {
    fullName: 0.95,
    company: 0.95,
    phoneNumbers: [0.9],
    emails: [0.9],
    website: 0.9
  };
  const ctx = { status: "done", fieldConfidence: fc };
  const result = reviewEngine.evaluate(data, 60, ctx);
  assert(result.required, "TEST E \u2014 required = true");
  assert(result.reasons.includes("LOW_CONFIDENCE" /* LOW_CONFIDENCE */), "TEST E \u2014 includes LOW_CONFIDENCE");
}
console.log("\nTEST F: overall 95%, only one meaningful field");
{
  const data = makeDraft({
    clientName: "Rahul Sharma"
  });
  const fc = { fullName: 0.95 };
  const ctx = { status: "done", fieldConfidence: fc };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(result.required, "TEST F \u2014 required = true");
  assert(result.reasons.includes("INSUFFICIENT_EXTRACTION" /* INSUFFICIENT_EXTRACTION */), "TEST F \u2014 includes INSUFFICIENT_EXTRACTION");
}
console.log("\nTEST G: overall 60%, phone invalid + uncertain email");
{
  const data = makeDraft({
    clientName: "Rahul Sharma",
    company: "Tech Corp",
    phoneNumbers: ["+9198344"],
    emails: []
  });
  const fc = { phoneNumbers: [0.85], fullName: 0.9, company: 0.9 };
  const fs = { emails: ["uncertain"] };
  const ctx = { status: "done", fieldConfidence: fc, fieldStatus: fs };
  const result = reviewEngine.evaluate(data, 60, ctx);
  assert(result.required, "TEST G \u2014 required = true");
  assert(result.reasons.includes("LOW_CONFIDENCE" /* LOW_CONFIDENCE */), "TEST G \u2014 includes LOW_CONFIDENCE");
  assert(result.reasons.includes("INVALID_PHONE" /* INVALID_PHONE */), "TEST G \u2014 includes INVALID_PHONE");
  assert(result.reasons.includes("UNCERTAIN_FIELD" /* UNCERTAIN_FIELD */), "TEST G \u2014 includes UNCERTAIN_FIELD");
  assert(result.reasons.length >= 3, `TEST G \u2014 at least 3 reasons (got ${result.reasons.length})`);
}
console.log("\nTEST H: overall 95%, phoneNumbers=[], fieldStatus phone uncertain, all else extracted");
{
  const data = makeDraft({
    clientName: "Rahul Sharma",
    company: "Tech Corp",
    designation: "Manager",
    emails: ["rahul@techcorp.com"],
    website: "techcorp.com",
    address: "Mumbai",
    phoneNumbers: []
  });
  const fc = {
    fullName: 1,
    company: 1,
    designation: 1,
    website: 1,
    address: 1,
    emails: [1]
  };
  const fs = {
    fullName: "extracted",
    company: "extracted",
    designation: "extracted",
    website: "extracted",
    address: "extracted",
    phoneNumbers: ["uncertain"],
    emails: ["extracted"]
  };
  const ctx = { status: "done", fieldConfidence: fc, fieldStatus: fs };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(result.required, "TEST H \u2014 required = true");
  assert(result.reasons.includes("UNCERTAIN_FIELD" /* UNCERTAIN_FIELD */), "TEST H \u2014 includes UNCERTAIN_FIELD");
  assert(!!result.fieldStatusViolations, "TEST H \u2014 has fieldStatusViolations");
  if (result.fieldStatusViolations) {
    const phoneV = result.fieldStatusViolations.find((v) => v.field === "phoneNumbers");
    assert(!!phoneV, "TEST H \u2014 phoneNumbers violation exists");
    assert(phoneV?.index === 0, "TEST H \u2014 violation index = 0");
    assert(phoneV?.value === null, "TEST H \u2014 violation value = null");
    assert(phoneV?.status === "uncertain", "TEST H \u2014 violation status = uncertain");
  }
}
console.log("\nTEST I: promotion scenario, verify ReviewResult shape for REQUIRES_REVIEW");
{
  const data = makeDraft({
    clientName: "ANITA SHARMA",
    company: "NOVATECH GLOBAL",
    designation: "SENIOR MARKETING MANAGER",
    emails: ["anita.sharma@novatechglobal.com"],
    website: "novatechglobal.com",
    address: "Mumbai",
    phoneNumbers: []
  });
  const fc = {
    fullName: 1,
    company: 1,
    designation: 1,
    website: 1,
    address: 1,
    emails: [1]
  };
  const fs = {
    fullName: "extracted",
    company: "extracted",
    designation: "extracted",
    website: "extracted",
    address: "extracted",
    phoneNumbers: ["uncertain"],
    emails: ["extracted"]
  };
  const ctx = { status: "done", fieldConfidence: fc, fieldStatus: fs };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(result.required, "TEST I \u2014 required = true");
  assert(result.reasons.includes("UNCERTAIN_FIELD" /* UNCERTAIN_FIELD */), "TEST I \u2014 includes UNCERTAIN_FIELD");
  assert(!!result.fieldStatusViolations, "TEST I \u2014 has fieldStatusViolations");
  if (result.fieldStatusViolations) {
    const phoneV = result.fieldStatusViolations.find((v) => v.field === "phoneNumbers");
    assert(!!phoneV, "TEST I \u2014 phoneNumbers violation exists");
    assert(phoneV?.index === 0, "TEST I \u2014 violation index = 0");
    assert(phoneV?.value === null, "TEST I \u2014 violation value = null (empty array)");
    assert(phoneV?.status === "uncertain", "TEST I \u2014 violation status = uncertain");
  }
  const reviewMetadata = {
    required: result.required,
    reason: result.reason,
    reasons: result.reasons,
    confidence: result.confidence,
    fieldConfidenceViolations: result.fieldConfidenceViolations ?? null,
    fieldStatusViolations: result.fieldStatusViolations ?? null,
    contactViolations: result.contactViolations ?? null
  };
  assert(reviewMetadata.required === true, "TEST I \u2014 reviewMetadata.required = true");
  assert(Array.isArray(reviewMetadata.reasons), "TEST I \u2014 reviewMetadata.reasons is array");
  assert(reviewMetadata.reasons.includes("UNCERTAIN_FIELD"), "TEST I \u2014 reviewMetadata.reasons includes UNCERTAIN_FIELD");
  assert(Array.isArray(reviewMetadata.fieldStatusViolations), "TEST I \u2014 reviewMetadata.fieldStatusViolations is array");
}
console.log("\nTEST J: normal lead, verify ReviewResult shape for NEW (no review)");
{
  const data = makeDraft({
    clientName: "Rahul Sharma",
    company: "Tech Corp",
    designation: "Manager",
    emails: ["rahul@techcorp.com"],
    website: "techcorp.com",
    phoneNumbers: ["+919876543210"]
  });
  const fc = {
    fullName: 0.95,
    company: 0.95,
    designation: 0.95,
    website: 0.95,
    phoneNumbers: [0.95],
    emails: [0.95]
  };
  const fs = {
    fullName: "extracted",
    company: "extracted",
    designation: "extracted",
    website: "extracted",
    phoneNumbers: ["extracted"],
    emails: ["extracted"]
  };
  const ctx = { status: "done", fieldConfidence: fc, fieldStatus: fs };
  const result = reviewEngine.evaluate(data, 95, ctx);
  assert(!result.required, "TEST J \u2014 required = false (normal lead)");
  assert(result.reasons.length === 0, "TEST J \u2014 no reasons");
  assert(!result.fieldStatusViolations, "TEST J \u2014 no fieldStatusViolations");
  const reviewMetadata = {
    required: result.required,
    reason: result.reason,
    reasons: result.reasons,
    confidence: result.confidence,
    fieldConfidenceViolations: result.fieldConfidenceViolations ?? null,
    fieldStatusViolations: result.fieldStatusViolations ?? null,
    contactViolations: result.contactViolations ?? null
  };
  assert(reviewMetadata.required === false, "TEST J \u2014 reviewMetadata.required = false");
  assert(reviewMetadata.reasons.length === 0, "TEST J \u2014 reviewMetadata.reasons empty");
}
console.log(`
${"=".repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
