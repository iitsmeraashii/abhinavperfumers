# Architecture Principles

## Purpose of the Architecture

The capture domain architecture exists to solve one problem: **multiple operating contexts need different capture behaviors, but they must share the same persistence infrastructure, the same offline queue, and the same sync protocol.**

Before this architecture existed, operating context was encoded as scattered `if (isOnline)` checks and hardcoded boolean flags throughout the UI and pipeline. Adding a second profile — or even changing one behavior — required touching every check site. The architecture replaces scattered checks with a single translation point (the Execution Engine) that converts user intent into an immutable contract (the Execution Plan) that all downstream code executes without knowing its origin.

---

## Core Design Philosophy

**Separate what from how.** Profiles declare what should happen. Strategies declare how to make it happen. Shared services execute the how without knowing the what.

**Make decisions once, at the right layer.** All behavioral decisions for a capture session are made in `CaptureExecutionEngine.buildPlan()` and frozen into an `ExecutionPlan`. No other layer makes behavioral decisions based on profile identity.

**Offline is a runtime condition, not a profile.** Whether the device is online or offline at any moment is a runtime environment fact, not a user intent decision. `isOnline` is captured at plan-build time and combined with `QueuePolicy` in routing decisions. A profile's strategy declares its queue preference (`ONLINE_FIRST`, `ALWAYS_QUEUE`); the engine combines that preference with actual connectivity to produce the routing outcome.

**Shared services must remain profile-agnostic.** Evidence managers, the offline queue, the backend sync layer, and the promotion service know nothing about profiles or strategies. They receive typed parameters (e.g. `UploadTiming`) and execute accordingly. This is the property that makes new profiles additive rather than invasive.

**Every sync operation is idempotent.** All backend operations use stable frontend-generated UUIDs. Whether an operation reaches the backend via live sync or queue replay is unobservable from the backend's perspective. This makes offline replay safe to execute multiple times.

---

## Layer Responsibilities

### 1. Capture Profile (User Intent)

**Location:** `src/capture/captureProfile.ts`

A `CaptureProfile` is a string union (`'CRM' | 'EXHIBITION'`) that identifies the operating context. It expresses the rep's intent for this capture session — accuracy-first (CRM) vs. throughput-first (Exhibition).

The profile file contains only:
- The type union
- The default value (`'CRM'`)
- Presentation metadata: display name, tagline, description, icon, color

**No runtime code reads the profile type directly.** The profile type is used only as a key to look up a strategy bundle from the registry.

### 2. Strategy Layer (Implementation Details)

**Location:** `src/capture/profileStrategies.ts`

Strategies are the **internal implementation details** of a profile's behavior. They are never exposed outside the `CaptureExecutionEngine`.

There are 7 strategy interfaces:

| Strategy | Purpose |
|---|---|
| `ValidationStrategy` | Determines whether a capture session has enough data to be promoted |
| `ReviewStrategy` | Evaluates whether the captured lead requires manual review before promotion |
| `AIStrategy` | Controls AI/OCR extraction timing (`waitForExtraction`) and review form display (`skipReviewForm`) |
| `QueueStrategy` | Declares the profile's preference for online/offline routing (`queueOnDisconnect`) |
| `UploadStrategy` | Declares evidence upload timing for each evidence type |
| `PromotionStrategy` | Builds the options object for the shared promotion service |
| `ResultStrategy` | Transforms the pipeline result (e.g. suppress toast, change outcome label) |

A `CaptureProfileStrategies` bundle is the complete set of all 7 strategies for one profile. The `PROFILE_STRATEGY_REGISTRY` maps each `CaptureProfile` value to its bundle. Adding a new profile requires adding a new bundle and a registry entry — nothing else.

### 3. Capture Profile Engine

**Location:** `src/capture/captureProfileEngine.ts`

A stateful singleton that resolves and locks the strategy bundle for the duration of a capture session. It is called once when a session begins (`resolve(profile)`) and reset when the session ends (`reset()`). Pipeline stages access strategies via `getStrategies()` rather than re-resolving the profile.

The engine prevents the profile from being re-resolved mid-session, ensuring behavioral consistency for the entire lifecycle of a single capture.

### 4. Capture Execution Engine (The Translator)

**Location:** `src/capture/CaptureExecutionEngine.ts`

This is the **single and only layer** that reads strategy flags and translates them into execution policies. It has two responsibilities:

**Responsibility 1 — Build the Execution Plan.** `buildPlan(profile, strategies, isOnline)` reads every strategy flag and produces an immutable `ExecutionPlan`. Every policy in the plan is derived from strategy flags. After `buildPlan()` returns, strategy flags are never read again.

**Responsibility 2 — Route all sync and queue operations.** All `route*()` methods accept a `QueuePolicy` and the current `isOnline` flag. They call `_shouldSync(queue, isOnline)` to decide whether to execute a live backend sync or enqueue the operation for offline replay. This is the only place in the codebase where the online/offline routing decision is made.

### 5. Execution Plan (The Runtime Contract)

**Location:** `src/capture/CaptureExecutionEngine.ts` — `ExecutionPlan` interface

The `ExecutionPlan` is an immutable snapshot produced once per capture session. It is the only artifact the UI and pipeline consume to make behavioral decisions.

| Field | Type | Behavioral effect |
|---|---|---|
| `isOnline` | `boolean` | Combined with `queue` by routing methods |
| `extraction` | `ExtractionPolicy` | `IMMEDIATE`: Vision/OCR runs at card capture. `DEFERRED`: skipped. |
| `upload.businessCard` | `UploadTiming` | `IMMEDIATE`: upload on card capture. `ON_SAVE`: upload at Save & Next. `NEVER`: suppressed. |
| `upload.notesImage` | `UploadTiming` | `ON_SAVE`: upload at Save & Next. `NEVER`: suppressed. |
| `upload.voiceNote` | `UploadTiming` | `IMMEDIATE`: upload+transcribe when recorded (if online). `ON_SAVE`: defer to Save & Next. |
| `queue` | `QueuePolicy` | `ONLINE_FIRST`: live sync when online, enqueue when offline. `ALWAYS_QUEUE`: always enqueue. |
| `review` | `ReviewPolicy` | `EVALUATE`: run review engine. `SKIP`: bypass review stage. |
| `promotion` | `PromotionPolicy` | `PROMOTE`: execute promotion. `SKIP`: return queued without inserting. |
| `result` | `ResultPolicy` | `PASS_THROUGH`: return result as-is. `SUPPRESS_TOAST`: transform via result strategy. |
| `strategies` | `CaptureProfileStrategies` | **Internal.** Used only by pipeline stages for validation rules, review evaluation, promotion options, and result transformation. Not a policy — not read for routing decisions. |

### 6. UI Layer

**Location:** `src/CaptureLeadPage.tsx`, `src/capture/BusinessCardCapture.tsx`

The UI layer builds the execution plan at session start and reads policy values from it. It passes policies as typed props or local constants. It calls `executionEngine.route*()` methods with the `QueuePolicy` from the plan.

The UI does not inspect strategy flags. It does not branch on profile identity. It does not call `profileEngine.getStrategies()` directly.

### 7. Processing Pipeline

**Location:** `src/capture/captureProcessingEngine.ts`

Five sequential stages executed at Save & Next:

```
Evidence → Extraction → Validation → Review → Promotion
```

Each stage reads `ctx.plan` for behavioral decisions. No stage reads a strategy flag for routing. Stages do call `ctx.plan.strategies.*` to execute strategy methods (validate, evaluate, buildOptions) — this is correct because strategy methods delegate to shared services; they do not branch on profile identity within the pipeline.

### 8. Shared Services

**Location:** `captureBackendSync.ts`, `captureOfflineQueue.ts`, `captureEvidenceManager.ts`, `voiceEvidenceManager.ts`, `capturePromotionService.ts`

Shared services execute operations. They receive typed parameters and execute accordingly. They never receive a profile identifier, a strategy object, or an `ExecutionPlan`. They do use `navigator.onLine` as an **operational guard** (preventing futile network calls) — this is not a routing decision and does not violate the architecture. Routing decisions are made upstream in the Execution Engine.

---

## Architectural Boundaries

```
CaptureProfile  ────────────────────────────────────────────────────────────────
                Only a registry key. Never read at runtime for behavior.
────────────────────────────────────────────────────────────────────────────────
Strategy Layer  ────────────────────────────────────────────────────────────────
                Internal. Never exported to UI or pipeline as decision inputs.
                Strategy FLAGS are read ONLY inside CaptureExecutionEngine.
                Strategy METHODS are called by pipeline stages (valid — they
                delegate to shared services, they do not branch on profile).
────────────────────────────────────────────────────────────────────────────────
ExecutionPlan   ────────────────────────────────────────────────────────────────
                The only artifact that crosses the boundary downward.
                Produced by CaptureExecutionEngine. Consumed by UI + Pipeline.
                Immutable after creation.
────────────────────────────────────────────────────────────────────────────────
Shared Services ────────────────────────────────────────────────────────────────
                Receive typed parameters only. No profile, no strategy, no plan.
                navigator.onLine is an operational guard, not a routing decision.
────────────────────────────────────────────────────────────────────────────────
```

---

## The Offline Philosophy

Offline is treated as a **runtime environment condition**, not a behavioral mode. The system does not have an "offline profile."

The architecture handles offline through two orthogonal mechanisms:

**1. QueuePolicy** — a profile's preference for how sync operations should be routed. `ONLINE_FIRST` means sync when online, enqueue when offline. `ALWAYS_QUEUE` means always enqueue regardless of connectivity.

**2. The Offline Queue** — a profile-agnostic IndexedDB store (`pending_ops`) that persists operations across page reloads. Every operation type that can be queued is idempotent. The queue flushes in creation order on reconnect.

The separation means: a profile can choose `ALWAYS_QUEUE` not because it's offline, but because deferred batch sync is preferable to live sync for its workflow. Offline handling itself (the queue, flush on reconnect, retry logic) is identical for all profiles.

---

## The Shared Service Philosophy

Shared services must not know which profile is active. This is enforced structurally: shared services receive no profile identifier, no strategy reference, and no `ExecutionPlan`. They receive only typed operational parameters.

The `captureEvidenceManager` receives `uploadTiming: UploadTiming`. It does not ask "is this CRM or Exhibition?" — it asks "is this IMMEDIATE, ON_SAVE, or NEVER?" The distinction matters because tomorrow there could be a third profile (Kiosk, Wholesale) that uses the same timing values with different motivations. The shared service remains unchanged.

This also means shared services can be tested, reasoned about, and evolved in isolation from the profile system.

---

## Architectural Invariants

> These rules are not guidelines. Violating any of them breaks the contract that makes the system extensible.

---

### INVARIANT 1 — Profiles express user intent only

**Rule:** A `CaptureProfile` value is a registry key and a UI label. It is never read in any runtime code path for behavioral decisions.

**Why:** If runtime code branches on profile identity (`if (profile === 'CRM')`), every new profile requires modifying that code. The profile system exists precisely to avoid this. Behavioral differences between profiles are expressed entirely through strategy bundles, which are resolved once at session start.

---

### INVARIANT 2 — Strategies are internal implementation details

**Rule:** Strategy interfaces and strategy flag values (`waitForExtraction`, `queueOnDisconnect`, etc.) must never appear in the UI layer, the processing pipeline's routing logic, or shared services.

**Why:** Strategy flags are the implementation of a profile's behavior. They belong to the profile, not to the system. Exposing them to downstream layers creates coupling between those layers and every current and future profile that might provide different values.

---

### INVARIANT 3 — CaptureExecutionEngine is the only translator

**Rule:** Strategy flags are read in exactly one place: the `_derive*Policy()` methods of `CaptureExecutionEngine`. No other file reads strategy flags.

**Why:** Centralizing translation in one place guarantees that adding a new profile only requires adding a strategy bundle and registry entry. If translation were distributed, every translation site would need to handle the new profile.

---

### INVARIANT 4 — ExecutionPlan is the runtime contract

**Rule:** All behavioral decisions downstream of the Execution Engine are made by reading `ExecutionPlan` fields. The plan is built once per session and is immutable.

**Why:** An immutable plan snapshot ensures behavioral consistency for the entire lifecycle of a single capture session. It also makes the system's behavior at any point in time fully inspectable — the plan is the complete record of what this session will do.

---

### INVARIANT 5 — The UI executes policies, not strategies

**Rule:** `CaptureLeadPage` and `BusinessCardCapture` read `ExecutionPlan` policy fields. They do not call `profileEngine.getStrategies()`, do not import strategy interfaces, and do not read strategy flags.

**Why:** The UI is responsible for user interaction. It should not be responsible for translating profile intent into behavior — that is the engine's job. Keeping strategy flags out of the UI makes UI code profile-neutral and therefore stable across new profiles.

---

### INVARIANT 6 — The pipeline executes policies, not strategies

**Rule:** `captureProcessingEngine` stages read `ctx.plan` policy fields for routing decisions. Calling strategy methods (`ctx.plan.strategies.validation.validate()`) is permitted because strategy methods delegate to shared services — they do not read profile identity.

**Why:** The pipeline is a series of sequential operations. Each stage's behavior is determined by the plan it receives. If stages read strategy flags directly, adding a profile would require modifying every stage.

---

### INVARIANT 7 — Shared services remain profile-agnostic

**Rule:** `captureBackendSync`, `captureOfflineQueue`, `captureEvidenceManager`, `voiceEvidenceManager`, and `capturePromotionService` must not receive a profile identifier, strategy reference, or `ExecutionPlan`. They receive only typed operational parameters.

**Why:** Shared services are the stable foundation of the system. They handle persistence, network I/O, and Supabase interaction. If they couple to profiles, they become a bottleneck for every profile addition. Keeping them profile-agnostic means they never need to change when a new profile is added.

---

### INVARIANT 8 — Offline is not a Capture Profile

**Rule:** The system must never have an `OFFLINE` capture profile. Offline handling is the responsibility of the `QueuePolicy` and the offline queue.

**Why:** Offline is an environmental condition, not a user intent. A CRM rep and an Exhibition rep both work offline — but they have different queue policies. Encoding offline as a profile would conflate two orthogonal dimensions and break the routing model.

---

### INVARIANT 9 — New profiles are additive

**Rule:** Adding a new capture profile must not require modifying `CaptureLeadPage`, `CaptureExecutionEngine`, `captureProcessingEngine`, any shared service, or any evidence manager. It requires only:
1. Adding a union member to `CaptureProfile` in `captureProfile.ts`
2. Adding a descriptor to `CAPTURE_PROFILE_DESCRIPTORS`
3. Implementing the 7 strategy interfaces
4. Adding the bundle to `PROFILE_STRATEGY_REGISTRY`

**Why:** This is the primary value the architecture delivers. If adding a profile requires touching shared code, the architecture has leaked.

---

### INVARIANT 10 — ExecutionPlan has no dead fields

**Rule:** Every field in `ExecutionPlan` must have at least one consumer that changes runtime behavior based on its value. Fields that are carried but never read must be removed.

**Why:** Dead fields in the contract are architectural debt. They create the false impression that a policy is being enforced when it is not. They must be verified on every significant architecture change.
