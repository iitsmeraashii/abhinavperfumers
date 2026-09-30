// Regression test for the WhatsApp template composer clipping fix (V404).
//
// Verifies the three structural invariants:
// 1. The conversation wrapper no longer has overflow-hidden or maxHeight
// 2. The message list area owns the scroll/height constraint
// 3. The composer has flex-shrink-0 so it can grow without being clipped
//
// Run with: npx tsx scripts/test_composerLayout.ts

import { readFileSync } from 'fs';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) { passed++; } else {
    failed++;
    console.error(`FAIL: ${label}`);
  }
}

const src = readFileSync('src/ConversationDetailPage.tsx', 'utf-8');

// ── 1. Conversation wrapper no longer clips ────────────────────────────────
//
// The wrapper div should not have overflow-hidden or a maxHeight style.
// We check the specific chat-area wrapper by finding the comment marker.

const chatWrapperIdx = src.indexOf('/* ── Chat area ── */');
assert(chatWrapperIdx !== -1, 'C1a: chat area comment marker found');

const chatWrapperSlice = src.slice(chatWrapperIdx, chatWrapperIdx + 300);
assert(
  !chatWrapperSlice.includes('overflow-hidden'),
  'C1b: chat area wrapper does NOT have overflow-hidden',
);
assert(
  !chatWrapperSlice.includes('maxHeight'),
  'C1c: chat area wrapper does NOT have maxHeight in its style',
);
assert(
  chatWrapperSlice.includes('minHeight'),
  'C1d: chat area wrapper still has minHeight (preserved)',
);

// ── 2. Message list area owns the scroll/height constraint ─────────────────

const messagesAreaIdx = src.indexOf('Messages scroll area');
assert(messagesAreaIdx !== -1, 'C2a: messages scroll area comment found');

const messagesSlice = src.slice(messagesAreaIdx, messagesAreaIdx + 300);
assert(
  messagesSlice.includes('overflow-y-auto'),
  'C2b: messages area has overflow-y-auto (scrollable)',
);
assert(
  messagesSlice.includes('maxHeight'),
  'C2c: messages area has maxHeight (owns the height constraint)',
);
assert(
  messagesSlice.includes('min-h-0') || messagesSlice.includes('flex-1'),
  'C2d: messages area has flex-1 and/or min-h-0 for proper flex sizing',
);

// ── 3. Composer has flex-shrink-0 ──────────────────────────────────────────

const composerIdx = src.indexOf('/* ── Composer ── */');
assert(composerIdx !== -1, 'C3a: composer comment marker found');

const composerSlice = src.slice(composerIdx, composerIdx + 200);
assert(
  composerSlice.includes('flex-shrink-0'),
  'C3b: composer div has flex-shrink-0 (can grow without being clipped)',
);

// ── 4. Overflow-hidden should not appear on the wrapper but IS fine elsewhere ──
//
// overflow-hidden is still used inside message bubbles (e.g. image previews),
// so we only verify it's gone from the chat-area wrapper, not globally.

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
