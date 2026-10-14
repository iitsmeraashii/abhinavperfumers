// Test stub for supabaseClient — supports the query builder chain used by
// TodaysFollowUpsLoader:
//   supabase.from('lead_follow_ups')
//     .select('id, lead_entries!inner(sales_rep_code)', { count: 'exact', head: true })
//     .eq('status', 'PENDING')
//     .gte('reminder_date', startStr)
//     .lt('reminder_date', endStr)
//     .eq('lead_entries.sales_rep_code', repCode)
//
// The handler is controllable via __setFromHandler.

type FromHandler = (table: string, selectArg: string, selectOpts: Record<string, unknown> | undefined, filters: FilterEntry[]) =>
  Promise<{ count: number | null; error: unknown; data: unknown }>;

export interface FilterEntry {
  method: 'eq' | 'gte' | 'lt';
  column: string;
  value: string;
}

let currentHandler: FromHandler = () =>
  Promise.resolve({ count: null, error: { message: 'no handler set' }, data: null });

export function __setFromHandler(handler: FromHandler): void {
  currentHandler = handler;
}

export function __resetFromHandler(): void {
  currentHandler = () => Promise.resolve({ count: null, error: { message: 'no handler set' }, data: null });
}

// Re-export rpc stub for compatibility with other modules that might import it
type RpcHandler = (fn: string, args: Record<string, unknown>) =>
  Promise<{ data: unknown; error: unknown }>;

let rpcHandler: RpcHandler = () =>
  Promise.resolve({ data: null, error: { message: 'no handler set' } });

export function __setRpcHandler(handler: RpcHandler): void {
  rpcHandler = handler;
}

export const supabase = {
  rpc: (fn: string, args?: Record<string, unknown>) =>
    rpcHandler(fn, args ?? {}),
  from(table: string) {
    const filters: FilterEntry[] = [];
    let selectArg = '';
    let selectOpts: Record<string, unknown> | undefined;

    const chain = {
      select(arg: string, opts?: Record<string, unknown>) {
        selectArg = arg;
        selectOpts = opts;
        return chain;
      },
      eq(column: string, value: string) {
        filters.push({ method: 'eq', column, value });
        return chain;
      },
      gte(column: string, value: string) {
        filters.push({ method: 'gte', column, value });
        return chain;
      },
      lt(column: string, value: string) {
        filters.push({ method: 'lt', column, value });
        return chain;
      },
      order() { return chain; },
      range() { return chain; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      then(resolve: (v: { count: number | null; error: unknown; data: unknown }) => void, reject?: (e: unknown) => void) {
        return currentHandler(table, selectArg, selectOpts, filters).then(resolve, reject);
      },
    };

    return chain;
  },
  channel: () => ({ on: () => ({ subscribe: () => {} }) }),
  removeChannel: () => {},
};
