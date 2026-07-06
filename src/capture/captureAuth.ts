// Shared authentication identity resolver for the Capture domain.
//
// Single source of truth for resolving the authenticated user ID and their
// sales representative code. Consumed by captureBackendSync and
// capturePromotionService (previously each had an identical local copy).

import { supabase } from '../supabaseClient';

export interface AuthIdentity {
  userId:  string;
  repCode: string | null;
}

// Returns the authenticated user's ID and rep_code, or null if unauthenticated.
// rep_code may be null if the profile row has not yet been linked — that is
// acceptable; the column is nullable in capture_sessions and lead_entries.

export async function getAuthIdentity(): Promise<AuthIdentity | null> {
  const { data } = await supabase.auth.getUser();
  const userId = data.user?.id;
  if (!userId) return null;

  const { data: profile } = await supabase
    .from('my_rep_profile')
    .select('rep_code')
    .maybeSingle();

  return { userId, repCode: profile?.rep_code ?? null };
}
