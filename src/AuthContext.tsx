import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { supabase } from './supabaseClient';

interface User {
  rep_code: string;
  name: string;
  role: string;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (rep_code: string, password: string) => Promise<string | null>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const token = localStorage.getItem('session_token');

      if (!token) {
        setLoading(false);
        return;
      }

      const now = new Date().toISOString();

      const { data, error } = await supabase
        .from('sales_representatives')
        .select('rep_code, name, role, session_expires_at, login_enabled')
        .eq('session_token', token)
        .maybeSingle();

      console.log('[session validation]', { data, error });

      if (error || !data || !data.login_enabled || !data.session_expires_at || data.session_expires_at <= now) {
        console.log('[session validation] invalid or expired — clearing localStorage');
        localStorage.removeItem('session_token');
        setUser(null);
      } else {
        setUser({ rep_code: data.rep_code, name: data.name, role: data.role });
      }

      setLoading(false);
    })();
  }, []);

  async function login(rep_code: string, password: string): Promise<string | null> {
    // Step 1: Find the user
    const { data: loginData, error: loginError } = await supabase
      .from('sales_representatives')
      .select('id, rep_code, name, role')
      .eq('rep_code', rep_code)
      .eq('password', password)
      .eq('login_enabled', true)
      .maybeSingle();

    console.log('[login response]', { loginData, loginError });

    if (loginError) {
      console.error('[login error]', loginError);
      return 'Invalid credentials';
    }

    if (!loginData) {
      console.log('[login] no matching user found');
      return 'Invalid credentials';
    }

    // Step 2: Generate session token
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    // Step 3: Update the user row with session info
    const { data: updateData, error: updateError } = await supabase
      .from('sales_representatives')
      .update({
        session_token: token,
        session_expires_at: expiresAt,
      })
      .eq('id', loginData.id)
      .select('id, session_token, session_expires_at');

    console.log('[update response]', { updateData, updateError });

    if (updateError) {
      console.error('[session update failed]', updateError);
      return 'Login failed. Please try again.';
    }

    // Step 4: Store token in localStorage
    localStorage.setItem('session_token', token);

    // Step 5: Set user in context (triggers redirect to dashboard/leads)
    setUser({ rep_code: loginData.rep_code, name: loginData.name, role: loginData.role });

    return null;
  }

  async function logout(): Promise<void> {
    const token = localStorage.getItem('session_token');

    if (token) {
      const { error } = await supabase
        .from('sales_representatives')
        .update({ session_token: null, session_expires_at: null })
        .eq('session_token', token);

      if (error) {
        console.error('[logout] failed to clear session in DB', error);
      }
    }

    localStorage.removeItem('session_token');
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
