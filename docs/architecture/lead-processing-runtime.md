# Lead Processing Runtime Architecture

> **Version:** 2.0
>
> **Status:** Architecture Contract (Source of Truth)
>
> This document defines the runtime behaviour of the AI Lead Processing Engine (ALPE), Capture Profiles, Processing Pipeline, Offline behaviour, Queue behaviour, Scheduler behaviour, Lead Promotion and all supported user journeys.
>
> This document is the single source of truth for implementation.
>
> If the implementation differs from this document, the implementation should be considered incorrect.

---

# 1. Purpose

The Lead Capture application is designed as an **Offline-First AI Lead Processing Platform**.

The application supports two Capture Profiles:

- CRM
- Exhibition

These profiles define the **user experience only**.

They do **not** define different processing implementations.

Both profiles ultimately use the same AI Lead Processing Engine (ALPE).

---

# 2. Design Principles

The following principles must never change.

## 2.1 Offline First

A captured lead must never be lost because of connectivity.

The system must always preserve:

- Business card images
- QR images
- Notes
- Audio
- Draft information
- Capture session

before any AI processing begins.

---

## 2.2 Single Processing Engine

There is only one processing engine.

All Capture Sessions are processed through ALPE.

There must never be separate CRM Processing and Exhibition Processing implementations.

---

## 2.3 Capture Experience is independent from Processing

Capture Profile controls:

- UI
- Navigation
- User workflow

Processing controls:

- AI
- Validation
- Decision
- Promotion

The two concerns must remain independent.

---

## 2.4 Promotion creates CRM Leads

The Capture UI must never directly create Lead Entries.

Lead Entries are created only after successful processing.

Promotion is the only component allowed to insert rows into lead_entries.

---

## 2.5 Scheduler owns Processing

Processing is never owned by the Capture UI.

The Scheduler owns:

- Job execution
- Retry
- Recovery
- Promotion

---

# 3. Capture Profiles

The application supports two Capture Profiles.

## CRM

Designed for:

- Lower-volume capture
- Immediate AI assistance
- User review before saving

Characteristics:

- AI extraction happens before Save
- User validates extracted information
- Human review is part of the workflow

---

## Exhibition

Designed for:

- High-volume capture
- Fast lead entry
- Background AI processing

Characteristics:

- Save & Next
- No waiting for AI
- Background processing

---

# 4. Connectivity

Connectivity is **NOT** a Capture Profile.

Possible values:

- Online
- Offline

Connectivity affects only when processing can begin.

Connectivity must never permanently change the user's selected Capture Profile.

---

# 5. Local Storage

IndexedDB is the canonical storage for Capture Sessions until promotion succeeds.

IndexedDB stores:

- Drafts
- Capture Sessions
- Business Card Assets
- QR Assets
- Notes Images
- Audio
- Processing Inbox

Nothing in IndexedDB is considered a CRM Lead.

---

# 6. Processing Inbox

The Processing Inbox contains Capture Sessions that still require system processing before becoming CRM Leads.

Examples:

- Waiting for AI
- Waiting for connectivity
- Waiting for validation
- Waiting for retry
- Waiting for promotion

A Capture Session leaves the Processing Inbox only after successful promotion.

---

# 7. Processing Pipeline

Every Capture Session follows the same processing pipeline.

```
Capture Session

↓

Upload Assets

↓

AI Extraction

↓

Validation

↓

Decision Engine

↓

Promotion

↓

Lead Entry

↓

Complete
```

There is only one processing pipeline.

---

# 8. CRM Journey

CRM is intended for interactive lead capture.

## CRM + Online

```
Capture

↓

AI Extraction

↓

Review Screen

↓

Sales Rep edits information

↓

Save

↓

Promotion

↓

Lead Entry
```

Characteristics:

- User waits for AI
- Human review happens before Save
- Processing completes immediately
- Lead is promoted immediately

This is the preferred CRM workflow.

---

## CRM + Offline

CRM workflow cannot complete because live AI is unavailable.

The application automatically falls back to the Exhibition capture experience **for the current capture session only**.

The user's selected Capture Profile remains CRM.

The user should **not** be required to manually change profiles.

Runtime journey:

```
Capture

↓

Business Card / QR / Manual

↓

Save & Next

↓

Optional Add More Details

↓

Capture Session stored locally

↓

Wait for connectivity

↓

Processing begins automatically

↓

AI Extraction

↓

Validation

↓

Decision

↓

Promotion

↓

Lead Entry
```

Important:

This is **NOT** considered a profile change.

Only the capture experience changes because CRM cannot function without live AI.

Once connectivity returns, the user's normal CRM experience automatically resumes.

---

# 9. Exhibition Journey

Exhibition is designed for high-volume capture.

## Exhibition + Online

```
Capture

↓

Save & Next

↓

Capture Session stored locally

↓

Scheduler immediately starts processing

↓

AI Extraction

↓

Validation

↓

Decision

↓

Promotion

↓

Lead Entry
```

Processing occurs in parallel while the sales representative captures additional leads.

---

## Exhibition + Offline

```
Capture

↓

Save & Next

↓

Capture Session stored locally

↓

Wait for connectivity

↓

Scheduler resumes automatically

↓

AI Extraction

↓

Validation

↓

Decision

↓

Promotion

↓

Lead Entry
```

No user interaction is required.

---

# 10. Processing Behaviour Matrix

| Scenario | User waits for AI | Capture stored locally | Processing starts | Human review before processing | Lead promoted immediately |
|------------|------------------|------------------------|------------------|-------------------------------|--------------------------|
| CRM + Online | Yes | Yes | Immediately | Yes | Yes |
| CRM + Offline | No | Yes | When online | No | Later |
| Exhibition + Online | No | Yes | Immediately (background) | No | Later (background) |
| Exhibition + Offline | No | Yes | When online | No | Later |

---

# 11. Validation Rules

Validation always occurs after AI extraction.

## CRM Online

Human review already occurred.

Validation confirms data integrity before promotion.

---

## Exhibition

Validation is fully automatic.

Minimum acceptable information:

- Business Card
OR
- QR
OR
- Name
OR
- Company
OR
- Phone

---

## CRM Offline

CRM Offline uses the **same validation rules as Exhibition** because no human review occurred before processing.

---

# 12. Decision Engine

The Decision Engine determines Lead Status.

Possible outcomes:

## NEW

High-confidence extraction.

Required information present.

---

## REQUIRES REVIEW

AI confidence below threshold.

Manual verification required.

---

## INVALID

Unable to identify sufficient contact information after processing.

Examples:

- No name
- No company
- No phone

---

## FAILED

Unexpected processing failure.

Retry eligible.

---

# 13. Scheduler

The Scheduler owns processing.

Responsibilities:

- Monitor Processing Inbox
- Pick next Capture Session
- Start Worker
- Retry failures
- Recover interrupted work
- Complete promotion

The Scheduler must never depend on Capture UI.

---

# 14. Worker

The Worker processes exactly one Capture Session.

Responsibilities:

- Load Processing Context
- Upload assets
- Execute AI
- Validate
- Run Decision Engine
- Promote Lead

The Worker must never know whether the Capture Session originated from CRM or Exhibition.

It processes only Processing Context.

---

# 15. Promotion

Promotion is responsible for:

- Creating lead_entries
- Updating Capture Session
- Marking Processing Complete

Promotion must be:

- Atomic
- Idempotent
- Recoverable

---

# 16. Retry

Retry applies only to processing failures.

Retry must preserve:

- Images
- Audio
- Notes
- AI results

User input must never be lost.

---

# 17. Recovery

If the application crashes:

The Scheduler resumes processing from the Processing Inbox.

No Capture Session should ever be lost.

---

# 18. Runtime States

```
CAPTURED

↓

QUEUED

↓

PROCESSING

↓

AI_COMPLETE

↓

VALIDATED

↓

PROMOTED

↓

COMPLETED
```

Failure path:

```
PROCESSING

↓

FAILED

↓

RETRY_PENDING

↓

PROCESSING
```

---

# 19. Architectural Constraints

The following rules are mandatory.

## Capture UI

Must never:

- Insert Lead Entries
- Execute Promotion
- Decide processing implementation

---

## Processing Engine

Must never depend on:

- Capture screens
- UI components

---

## Scheduler

Must be solely responsible for:

- Starting processing
- Retrying work
- Recovery
- Promotion

---

## Promotion

Must be the only component allowed to create Lead Entries.

---

# 20. Future Implementation Notes

The application currently exposes two Capture Profiles:

- CRM
- Exhibition

These names are part of the existing implementation and should remain unchanged.

Although Offline CRM temporarily uses the Exhibition capture experience for the current session because live AI is unavailable, this is **not** considered a Capture Profile change.

The user's selected profile remains CRM.

This behaviour exists only to preserve a seamless Offline-First user experience.

---

# 21. Source of Truth

This document defines the expected runtime behaviour of the Lead Processing Engine.

Future implementation, refactoring and feature development must conform to this document.

If code conflicts with this document, the implementation should be updated rather than changing the architecture described here.