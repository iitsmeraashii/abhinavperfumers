// Lifecycle wiring harness that replicates the EXACT production wiring from
// DashboardPage.tsx — the same refs, state transitions, effect lifecycle,
// cleanup, and identity display guard — using the real DashboardMetricsLoader.
//
// This exercises the production lifecycle wiring without needing react-dom's
// renderer. It mirrors the component's:
//   - loaderRef (ref-held DashboardMetricsLoader instance)
//   - data / dataIdentity / loading / error state
//   - fetchData callback (sets loading + clears error at start)
//   - main effect (invalidates, resets state, calls fetchData)
//   - cleanup effect (invalidate only, NOT unmount — StrictMode-safe)
//   - identity display guard (displayData / showLoading / showError)
//
// The harness is driven by calling setIdentity/setAuthMode/setIsOnline to
// simulate prop/state changes, then flushPromises to resolve async work.

import {
  DashboardMetricsLoader,
  EMPTY_DASHBOARD,
  identityKey,
  isAuthorized,
  deriveDisplayState,
  ERR_SIGN_IN,
  ERR_WAITING,
  ERR_UNAVAILABLE,
  type DashboardData,
} from '../src/dashboardMetricsLoader';

export interface HarnessState {
  displayData: DashboardData;
  showLoading: boolean;
  showError: boolean;
  errorMessage: string;
  dataIdentity: string | null;
}

interface SettableUser {
  authUserId?: string;
  rep_code: string;
  role: string;
}

export class DashboardWiringHarness {
  // ── Refs (mirror DashboardPage) ──
  private loader: DashboardMetricsLoader = new DashboardMetricsLoader();

  // ── State (mirror DashboardPage) ──
  private data: DashboardData = EMPTY_DASHBOARD;
  private dataIdentity: string | null = null;
  private errorIdentity: string | null = null;
  private loading = true;
  private error = '';

  // ── Props/inputs (controlled by test) ──
  private user: SettableUser | null = null;
  private authMode: 'unauthenticated' | 'online' | 'offline-restored' = 'unauthenticated';
  private isOnline = true;

  // ── Cleanup tracking ──
  private cleanupRegistered = false;

  // Simulate setting the user/auth context.
  setUser(user: SettableUser | null): void {
    this.user = user;
  }

  setAuthMode(mode: 'unauthenticated' | 'online' | 'offline-restored'): void {
    this.authMode = mode;
  }

  setIsOnline(online: boolean): void {
    this.isOnline = online;
  }

  private get currentIdentity(): string | null {
    return identityKey(this.user);
  }

  // ── fetchData (exact mirror of DashboardPage's useCallback) ──
  async fetchData(): Promise<void> {
    this.loading = true;
    this.error = '';
    const result = await this.loader.load(this.currentIdentity);

    if (result.kind === 'stale') return;

    if (result.kind === 'error') {
      this.error = result.message;
      this.data = EMPTY_DASHBOARD;
      this.dataIdentity = null;
      this.errorIdentity = this.currentIdentity;
      this.loading = false;
      return;
    }

    this.data = result.data;
    this.dataIdentity = this.currentIdentity;
    this.errorIdentity = null;
    this.loading = false;
  }

  // ── Main effect (exact mirror of DashboardPage's useEffect) ──
  // Fires on mount, identity change, authMode change, transport change.
  triggerEffect(): void {
    this.data = EMPTY_DASHBOARD;
    this.dataIdentity = null;
    this.errorIdentity = null;
    this.loading = true;
    this.error = '';
    this.loader.invalidate();
    // Fire-and-forget, just like the real component.
    void this.fetchData();
  }

  // ── Cleanup effect (exact mirror of DashboardPage's cleanup useEffect) ──
  // In StrictMode: setup → cleanup → setup. Cleanup must NOT permanently
  // unmount the loader — it only invalidates in-flight requests.
  cleanup(): void {
    this.loader.invalidate();
  }

  // Simulate StrictMode: setup → cleanup → setup
  strictModeCycle(): void {
    this.triggerEffect();
    this.cleanup();
    this.triggerEffect();
  }

  // ── Identity display guard (exact mirror of DashboardPage's derived values) ──
  get state(): HarnessState {
    const currentIdentity = this.currentIdentity;
    const { displayData, showLoading, showError } = deriveDisplayState(
      this.loading, this.error, this.dataIdentity, this.errorIdentity, currentIdentity, this.data,
    );

    return {
      displayData,
      showLoading,
      showError,
      errorMessage: this.error,
      dataIdentity: this.dataIdentity,
    };
  }
}
