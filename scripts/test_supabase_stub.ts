// Stub for supabaseClient — provides a no-op supabase object for Node tests.
export const supabase = {
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
    insert: () => Promise.resolve({ error: null }),
  }),
  channel: () => ({
    on: () => ({ subscribe: () => {} }),
  }),
  removeChannel: () => {},
};
