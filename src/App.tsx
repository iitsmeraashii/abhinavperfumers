import { useState } from 'react';
import { AuthProvider, useAuth } from './AuthContext';
import LoginPage from './LoginPage';
import LeadsPage from './LeadsPage';
import LeadDetailPage from './LeadDetailPage';
import DashboardPage from './DashboardPage';
import TemplatesPage from './TemplatesPage';
import EventsPage from './EventsPage';
import SystemNotificationsPage from './SystemNotificationsPage';
import FollowUpCompleteModal from './FollowUpCompleteModal';
import { LogOut, Loader2, LayoutDashboard, List, FileText, CalendarDays, Bell } from 'lucide-react';

type Tab = 'dashboard' | 'leads' | 'templates' | 'events' | 'notifications';

function Layout() {
  const { user, logout } = useAuth();
  const isAdmin = user?.role === 'admin';

  const params = new URLSearchParams(window.location.search);
  const initialLeadId = params.get('lead');
  const initialFollowUpId = params.get('followup');

  const [tab, setTab] = useState<Tab>(isAdmin ? 'dashboard' : 'leads');
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(initialLeadId);
  const [leadsEventFilter, setLeadsEventFilter] = useState<string | undefined>(undefined);
  const [followUpModalId, setFollowUpModalId] = useState<string | null>(initialFollowUpId);

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
    const url = new URL(window.location.href);
    url.searchParams.delete('lead');
    window.history.pushState({}, '', url.toString());
    setLeadsEventFilter(undefined);
  }

  function handleCloseFollowUpModal() {
    setFollowUpModalId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('followup');
    window.history.replaceState({}, '', url.toString());
  }

  function handleViewLeads(eventCode: string) {
    setLeadsEventFilter(eventCode);
    setTab('leads');
    setSelectedLeadId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('lead');
    window.history.pushState({}, '', url.toString());
  }

  return (
    <div className="min-h-screen bg-stone-50">
      <header className="bg-white border-b border-stone-200 px-6 py-0 flex items-stretch justify-between">
        {/* Left: brand + tabs */}
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
                  ${tab === 'dashboard'
                    ? 'border-stone-800 text-stone-900'
                    : 'border-transparent text-stone-500 hover:text-stone-700'}`}
              >
                <LayoutDashboard className="w-4 h-4" />
                Dashboard
              </button>
            )}
            <button
              onClick={() => handleTabChange('leads')}
              className={`flex items-center gap-1.5 px-3 text-sm font-medium border-b-2 transition-colors
                ${tab === 'leads'
                  ? 'border-stone-800 text-stone-900'
                  : 'border-transparent text-stone-500 hover:text-stone-700'}`}
            >
              <List className="w-4 h-4" />
              Leads
            </button>
            {isAdmin && (
              <button
                onClick={() => handleTabChange('events')}
                className={`flex items-center gap-1.5 px-3 text-sm font-medium border-b-2 transition-colors
                  ${tab === 'events'
                    ? 'border-stone-800 text-stone-900'
                    : 'border-transparent text-stone-500 hover:text-stone-700'}`}
              >
                <CalendarDays className="w-4 h-4" />
                Events
              </button>
            )}
            {isAdmin && (
              <button
                onClick={() => handleTabChange('templates')}
                className={`flex items-center gap-1.5 px-3 text-sm font-medium border-b-2 transition-colors
                  ${tab === 'templates'
                    ? 'border-stone-800 text-stone-900'
                    : 'border-transparent text-stone-500 hover:text-stone-700'}`}
              >
                <FileText className="w-4 h-4" />
                Templates
              </button>
            )}
            {isAdmin && (
              <button
                onClick={() => handleTabChange('notifications')}
                className={`flex items-center gap-1.5 px-3 text-sm font-medium border-b-2 transition-colors
                  ${tab === 'notifications'
                    ? 'border-stone-800 text-stone-900'
                    : 'border-transparent text-stone-500 hover:text-stone-700'}`}
              >
                <Bell className="w-4 h-4" />
                Notifications
              </button>
            )}
          </nav>
        </div>

        {/* Right: user info + logout */}
        <div className="flex items-center gap-4 py-3">
          <div className="text-right">
            <p className="text-sm font-medium text-stone-800">{user?.name}</p>
            <p className="text-xs text-stone-500">{user?.rep_code} &middot; {user?.role}</p>
          </div>
          <button
            onClick={logout}
            className="flex items-center gap-1.5 text-sm text-stone-500 hover:text-red-600 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Logout
          </button>
        </div>
      </header>

      <main>
        {tab === 'dashboard' && isAdmin && !selectedLeadId && <DashboardPage />}
        {tab === 'events' && isAdmin && !selectedLeadId && <EventsPage onViewLeads={handleViewLeads} />}
        {tab === 'templates' && isAdmin && !selectedLeadId && <TemplatesPage />}
        {tab === 'notifications' && isAdmin && !selectedLeadId && <SystemNotificationsPage />}
        {(tab === 'leads' || (!isAdmin && tab !== 'leads')) && !selectedLeadId && (
          <LeadsPage
            key={leadsEventFilter ?? '__all__'}
            onSelectLead={handleSelectLead}
            initialEventCode={leadsEventFilter}
          />
        )}
        {selectedLeadId && (
          <LeadDetailPage leadId={selectedLeadId} onBack={handleBack} />
        )}
      </main>

      {followUpModalId && (
        <FollowUpCompleteModal
          followUpId={followUpModalId}
          onClose={handleCloseFollowUpModal}
        />
      )}
    </div>
  );
}

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
