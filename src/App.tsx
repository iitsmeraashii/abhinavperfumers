import { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './AuthContext';
import LoginPage from './LoginPage';
import LeadsPage from './LeadsPage';
import type { LeadsInitialFilters } from './LeadsPage';
import LeadDetailPage from './LeadDetailPage';
import DashboardPage from './DashboardPage';
import type { DashboardFilter } from './DashboardPage';
import TemplatesPage from './TemplatesPage';
import EventsPage from './EventsPage';
import SystemNotificationsPage from './SystemNotificationsPage';
import FollowUpCompleteModal from './FollowUpCompleteModal';
import CaptureLeadPage from './CaptureLeadPage';
import {
  LogOut, Loader2,
  LayoutDashboard, List, FileText, CalendarDays, Bell, PlusCircle,
  MoreHorizontal, X,
} from 'lucide-react';

type Tab = 'dashboard' | 'leads' | 'capture' | 'templates' | 'events' | 'notifications';

// ─── Mobile bottom nav tab definition ────────────────────────────────────────

interface MobileTab {
  id: Tab;
  label: string;
  icon: React.ReactNode;
  adminOnly?: boolean;
  emphasize?: boolean;
}

const MOBILE_TABS: MobileTab[] = [
  { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard className="w-5 h-5" />, adminOnly: true },
  { id: 'leads',     label: 'Leads',     icon: <List className="w-5 h-5" /> },
  { id: 'capture',   label: 'Capture',   icon: <PlusCircle className="w-5 h-5" />, emphasize: true },
  { id: 'events',    label: 'Events',    icon: <CalendarDays className="w-5 h-5" />, adminOnly: true },
];

// ─── Mobile bottom nav bar ────────────────────────────────────────────────────

interface MobileNavProps {
  tab: Tab;
  isAdmin: boolean;
  onTabChange: (t: Tab) => void;
  onMorePress: () => void;
}

function MobileBottomNav({ tab, isAdmin, onTabChange, onMorePress }: MobileNavProps) {
  const visibleTabs = MOBILE_TABS.filter(t => !t.adminOnly || isAdmin);
  // "More" catches overflow admin tabs
  const moreActive = tab === 'templates' || tab === 'notifications';

  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-40 bg-white border-t border-stone-200 flex md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {visibleTabs.map(t => {
        const active = tab === t.id;
        return (
          <button
            key={t.id}
            onClick={() => onTabChange(t.id)}
            className="flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[3.75rem] px-1 relative transition-colors"
            aria-label={t.label}
          >
            {/* Capture tab pill emphasis */}
            {t.emphasize ? (
              <span className={`flex items-center justify-center w-11 h-11 rounded-full transition-all duration-150
                ${active
                  ? 'bg-stone-900 text-white shadow-lg scale-105'
                  : 'bg-stone-100 text-stone-600 hover:bg-stone-200'}`}>
                {t.icon}
              </span>
            ) : (
              <span className={`transition-colors duration-150 ${active ? 'text-stone-900' : 'text-stone-400'}`}>
                {t.icon}
              </span>
            )}
            {!t.emphasize && (
              <span className={`text-[10px] font-medium leading-none transition-colors duration-150
                ${active ? 'text-stone-900' : 'text-stone-400'}`}>
                {t.label}
              </span>
            )}
            {t.emphasize && (
              <span className={`text-[10px] font-medium leading-none mt-0.5 transition-colors duration-150
                ${active ? 'text-stone-900' : 'text-stone-500'}`}>
                {t.label}
              </span>
            )}
            {/* Active dot indicator for non-emphasize tabs */}
            {!t.emphasize && active && (
              <span className="absolute top-2 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-stone-900" />
            )}
          </button>
        );
      })}

      {/* More button — only shown to admins who have overflow tabs */}
      {isAdmin && (
        <button
          onClick={onMorePress}
          className="flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[3.75rem] px-1 relative transition-colors"
          aria-label="More"
        >
          <span className={`transition-colors duration-150 ${moreActive ? 'text-stone-900' : 'text-stone-400'}`}>
            <MoreHorizontal className="w-5 h-5" />
          </span>
          <span className={`text-[10px] font-medium leading-none transition-colors duration-150
            ${moreActive ? 'text-stone-900' : 'text-stone-400'}`}>
            More
          </span>
          {moreActive && (
            <span className="absolute top-2 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-stone-900" />
          )}
        </button>
      )}
    </nav>
  );
}

// ─── Mobile "More" drawer ─────────────────────────────────────────────────────

interface MoreDrawerProps {
  tab: Tab;
  isAdmin: boolean;
  userName: string;
  repCode: string;
  role: string;
  onTabChange: (t: Tab) => void;
  onClose: () => void;
  onLogout: () => void;
}

function MobileMoreDrawer({ tab, isAdmin, userName, repCode, role, onTabChange, onClose, onLogout }: MoreDrawerProps) {
  const items = [
    isAdmin && { id: 'templates' as Tab, label: 'Templates', icon: <FileText className="w-5 h-5" /> },
    isAdmin && { id: 'notifications' as Tab, label: 'Notifications', icon: <Bell className="w-5 h-5" /> },
  ].filter(Boolean) as { id: Tab; label: string; icon: React.ReactNode }[];

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30 md:hidden"
        onClick={onClose}
      />
      {/* Sheet */}
      <div
        className="fixed inset-x-0 bottom-0 z-50 bg-white rounded-t-2xl shadow-2xl md:hidden"
        style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-2">
          <div className="w-10 h-1 rounded-full bg-stone-200" />
        </div>

        {/* User info */}
        <div className="px-5 pt-1 pb-4 border-b border-stone-100">
          <p className="text-sm font-semibold text-stone-900">{userName}</p>
          <p className="text-xs text-stone-500 mt-0.5">{repCode} · {role}</p>
        </div>

        {/* Nav items */}
        <div className="px-3 pt-2">
          {items.map(item => (
            <button
              key={item.id}
              onClick={() => { onTabChange(item.id); onClose(); }}
              className={`w-full flex items-center gap-3 px-4 py-3.5 rounded-xl text-left transition-colors
                ${tab === item.id ? 'bg-stone-100 text-stone-900 font-medium' : 'text-stone-600 hover:bg-stone-50'}`}
            >
              {item.icon}
              <span className="text-sm">{item.label}</span>
            </button>
          ))}
        </div>

        {/* Logout */}
        <div className="px-3 pt-2 border-t border-stone-100 mt-2">
          <button
            onClick={onLogout}
            className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl text-left text-red-600 hover:bg-red-50 transition-colors"
          >
            <LogOut className="w-5 h-5" />
            <span className="text-sm font-medium">Log Out</span>
          </button>
        </div>

        <button
          onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 rounded-full bg-stone-100 flex items-center justify-center text-stone-500 hover:bg-stone-200 transition-colors"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </>
  );
}

// ─── Main layout ──────────────────────────────────────────────────────────────

function Layout() {
  const { user, logout } = useAuth();
  const isAdmin = user?.role === 'admin';

  const params = new URLSearchParams(window.location.search);
  const initialLeadId = params.get('lead');
  const initialFollowUpId = params.get('followup');

  const [tab, setTab] = useState<Tab>(isAdmin ? 'dashboard' : 'capture');
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(initialLeadId);
  const [leadsEventFilter, setLeadsEventFilter] = useState<string | undefined>(undefined);
  const [leadsInitialFilters, setLeadsInitialFilters] = useState<LeadsInitialFilters | undefined>(undefined);
  const [followUpModalId, setFollowUpModalId] = useState<string | null>(initialFollowUpId);
  const [moreDrawerOpen, setMoreDrawerOpen] = useState(false);

  useEffect(() => {
    function onPopState() {
      const p = new URLSearchParams(window.location.search);
      setSelectedLeadId(p.get('lead'));
      setFollowUpModalId(p.get('followup'));
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  function handleSelectLead(id: string) {
    setSelectedLeadId(id);
    setTab('leads');
    const url = new URL(window.location.href);
    url.searchParams.set('lead', id);
    window.history.pushState({}, '', url.toString());
  }

  function handleBack() {
    setSelectedLeadId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('lead');
    window.history.pushState({}, '', url.toString());
  }

  function handleTabChange(t: Tab) {
    setTab(t);
    setSelectedLeadId(null);
    setMoreDrawerOpen(false);
    const url = new URL(window.location.href);
    url.search = '';
    window.history.pushState({}, '', url.toString());
    setLeadsEventFilter(undefined);
    setLeadsInitialFilters(undefined);
  }

  function handleCloseFollowUpModal() {
    setFollowUpModalId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('followup');
    window.history.replaceState({}, '', url.toString());
  }

  function handleViewLeads(eventCode: string) {
    setLeadsEventFilter(eventCode);
    setLeadsInitialFilters(undefined);
    setTab('leads');
    setSelectedLeadId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('lead');
    window.history.pushState({}, '', url.toString());
  }

  function handleNavigateFromDashboard(filter: DashboardFilter) {
    setLeadsEventFilter(undefined);
    setLeadsInitialFilters(filter);
    setTab('leads');
    setSelectedLeadId(null);
    const url = new URL(window.location.href);
    url.search = '';
    window.history.pushState({}, '', url.toString());
  }

  return (
    <div className="min-h-screen bg-stone-50">

      {/* ── Desktop top header (hidden on mobile) ── */}
      <header className="hidden md:flex bg-white border-b border-stone-200 px-6 py-0 items-stretch justify-between">
        <div className="flex items-stretch gap-6">
          <div className="flex flex-col justify-center py-3 pr-4 border-r border-stone-100">
            <h1 className="text-lg font-semibold text-stone-800 leading-tight">
              {import.meta.env.VITE_APP_NAME || 'Abhinav Perfumers'}
            </h1>
            <p className="text-xs text-stone-500">Sales Portal</p>
          </div>
          <nav className="flex items-stretch gap-1">
            {isAdmin && (
              <button
                onClick={() => handleTabChange('dashboard')}
                className={`flex items-center gap-1.5 px-3 text-sm font-medium border-b-2 transition-colors
                  ${tab === 'dashboard' ? 'border-stone-800 text-stone-900' : 'border-transparent text-stone-500 hover:text-stone-700'}`}
              >
                <LayoutDashboard className="w-4 h-4" /> Dashboard
              </button>
            )}
            <button
              onClick={() => handleTabChange('leads')}
              className={`flex items-center gap-1.5 px-3 text-sm font-medium border-b-2 transition-colors
                ${tab === 'leads' ? 'border-stone-800 text-stone-900' : 'border-transparent text-stone-500 hover:text-stone-700'}`}
            >
              <List className="w-4 h-4" /> Leads
            </button>
            <button
              onClick={() => handleTabChange('capture')}
              className={`flex items-center gap-1.5 px-3 text-sm font-medium border-b-2 transition-colors
                ${tab === 'capture' ? 'border-stone-800 text-stone-900' : 'border-transparent text-stone-500 hover:text-stone-700'}`}
            >
              <PlusCircle className="w-4 h-4" /> Capture Lead
            </button>
            {isAdmin && (
              <button
                onClick={() => handleTabChange('events')}
                className={`flex items-center gap-1.5 px-3 text-sm font-medium border-b-2 transition-colors
                  ${tab === 'events' ? 'border-stone-800 text-stone-900' : 'border-transparent text-stone-500 hover:text-stone-700'}`}
              >
                <CalendarDays className="w-4 h-4" /> Events
              </button>
            )}
            {isAdmin && (
              <button
                onClick={() => handleTabChange('templates')}
                className={`flex items-center gap-1.5 px-3 text-sm font-medium border-b-2 transition-colors
                  ${tab === 'templates' ? 'border-stone-800 text-stone-900' : 'border-transparent text-stone-500 hover:text-stone-700'}`}
              >
                <FileText className="w-4 h-4" /> Templates
              </button>
            )}
            {isAdmin && (
              <button
                onClick={() => handleTabChange('notifications')}
                className={`flex items-center gap-1.5 px-3 text-sm font-medium border-b-2 transition-colors
                  ${tab === 'notifications' ? 'border-stone-800 text-stone-900' : 'border-transparent text-stone-500 hover:text-stone-700'}`}
              >
                <Bell className="w-4 h-4" /> Notifications
              </button>
            )}
          </nav>
        </div>
        <div className="flex items-center gap-4 py-3">
          <div className="text-right">
            <p className="text-sm font-medium text-stone-800">{user?.name}</p>
            <p className="text-xs text-stone-500">{user?.rep_code} &middot; {user?.role}</p>
          </div>
          <button
            onClick={logout}
            className="flex items-center gap-1.5 text-sm text-stone-500 hover:text-red-600 transition-colors"
          >
            <LogOut className="w-4 h-4" /> Logout
          </button>
        </div>
      </header>

      {/* ── Mobile top bar (brand only, no nav) ── */}
      <header className="flex md:hidden items-center justify-between bg-white border-b border-stone-200 px-4 py-3">
        <div>
          <h1 className="text-base font-semibold text-stone-800 leading-tight">
            {import.meta.env.VITE_APP_NAME || 'Abhinav Perfumers'}
          </h1>
          <p className="text-[11px] text-stone-400 leading-tight">Sales Portal</p>
        </div>
        <div className="text-right">
          <p className="text-sm font-medium text-stone-800 leading-tight">{user?.name}</p>
          <p className="text-[11px] text-stone-400 leading-tight">{user?.rep_code} · {user?.role}</p>
        </div>
      </header>

      {/* ── Page content ── */}
      {/* pb-mobile-nav adds clearance for fixed bottom nav on mobile */}
      <main className="pb-mobile-nav md:pb-0">
        {tab === 'dashboard' && isAdmin && !selectedLeadId && <DashboardPage onNavigateToLeads={handleNavigateFromDashboard} />}
        {tab === 'events'    && isAdmin && !selectedLeadId && <EventsPage onViewLeads={handleViewLeads} />}
        {tab === 'templates' && isAdmin && !selectedLeadId && <TemplatesPage />}
        {tab === 'notifications' && isAdmin && !selectedLeadId && <SystemNotificationsPage />}
        {tab === 'capture'   && !selectedLeadId && <CaptureLeadPage />}
        {tab === 'leads'     && !selectedLeadId && (
          <LeadsPage
            key={[leadsEventFilter ?? '', JSON.stringify(leadsInitialFilters ?? {})].join('|')}
            onSelectLead={handleSelectLead}
            initialEventCode={leadsEventFilter}
            initialFilters={leadsInitialFilters}
          />
        )}
        {selectedLeadId && (
          <LeadDetailPage leadId={selectedLeadId} onBack={handleBack} />
        )}
      </main>

      {/* ── Mobile bottom nav ── */}
      <MobileBottomNav
        tab={tab}
        isAdmin={isAdmin}
        onTabChange={handleTabChange}
        onMorePress={() => setMoreDrawerOpen(true)}
      />

      {/* ── Mobile "More" drawer ── */}
      {moreDrawerOpen && (
        <MobileMoreDrawer
          tab={tab}
          isAdmin={isAdmin}
          userName={user?.name ?? ''}
          repCode={user?.rep_code ?? ''}
          role={user?.role ?? ''}
          onTabChange={handleTabChange}
          onClose={() => setMoreDrawerOpen(false)}
          onLogout={logout}
        />
      )}

      {followUpModalId && (
        <FollowUpCompleteModal
          followUpId={followUpModalId}
          onClose={handleCloseFollowUpModal}
        />
      )}
    </div>
  );
}

// ─── Routing ──────────────────────────────────────────────────────────────────

function AppRoutes() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-amber-700 animate-spin" />
      </div>
    );
  }

  return user ? <Layout /> : <LoginPage />;
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
