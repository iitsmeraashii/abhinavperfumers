import { supabase } from './supabaseClient';

export interface LeadActivity {
  id: string;
  lead_id: string;
  actor_user_id: string | null;
  actor_rep_code: string | null;
  actor_name: string | null;
  action_type: string;
  field_name: string | null;
  old_value: string | null;
  new_value: string | null;
  note: string;
  created_at: string;
}

export const ACTIVITY_PAGE_SIZE = 20;

export async function fetchLeadActivities(
  leadId: string,
  page: number,
  pageSize: number = ACTIVITY_PAGE_SIZE,
): Promise<{ activities: LeadActivity[]; hasMore: boolean }> {
  const from = page * pageSize;
  const to = from + pageSize;
  const { data, error } = await supabase
    .from('lead_activities')
    .select('id, lead_id, actor_user_id, actor_rep_code, actor_name, action_type, field_name, old_value, new_value, note, created_at')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) {
    console.warn('[leadActivityService] fetch failed:', error.message);
    return { activities: [], hasMore: false };
  }

  const rows = (data ?? []) as unknown as LeadActivity[];
  const hasMore = rows.length > pageSize;
  return { activities: rows.slice(0, pageSize), hasMore };
}

export async function updateLeadWithAudit(
  leadId: string,
  updates: Record<string, unknown>,
): Promise<{ success: boolean; lead: Record<string, unknown> | null; activitiesCreated: number; error: string | null }> {
  const { data, error } = await supabase.rpc('update_lead_with_audit', {
    p_lead_id: leadId,
    p_updates: updates,
  });

  if (error) {
    return { success: false, lead: null, activitiesCreated: 0, error: error.message };
  }

  const result = data as { lead: Record<string, unknown>; activities_created: number };
  return {
    success: true,
    lead: result.lead,
    activitiesCreated: result.activities_created,
    error: null,
  };
}
