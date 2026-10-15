// Test stub for supabaseClient — replaces the real Supabase client in tests.
// The rpc function is controllable via `__setRpcHandler`.

type RpcHandler = (fn: string, args: Record<string, unknown>) =>
  Promise<{ data: unknown; error: unknown }>;

let currentHandler: RpcHandler = () =>
  Promise.resolve({ data: null, error: { message: 'no handler set' } });

export function __setRpcHandler(handler: RpcHandler): void {
  currentHandler = handler;
}

export function __resetRpcHandler(): void {
  currentHandler = () => Promise.resolve({ data: null, error: { message: 'no handler set' } });
}

export const supabase = {
  rpc: (fn: string, args?: Record<string, unknown>) =>
    currentHandler(fn, args ?? {}),
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
  }),
  channel: () => ({ on: () => ({ subscribe: () => {} }) }),
  removeChannel: () => {},
};
