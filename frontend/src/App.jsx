import { useState } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import BottomNav  from './components/BottomNav'
import Sidebar    from './components/Sidebar'
import PaymentClaimsInbox from './components/PaymentClaimsInbox'
import Home        from './pages/Home'
import Groups      from './pages/Groups'
import GroupDetail from './pages/GroupDetail'
import AddExpense  from './pages/AddExpense'
import NewGroup    from './pages/NewGroup'
import MonthlyGroup from './pages/MonthlyGroup'
import EditGroup   from './pages/EditGroup'
import History     from './pages/History'
import MLAnalysis  from './pages/MLAnalysis'
import Insights    from './pages/Insights'
import CardBill    from './pages/CardBill'
import MyPlaces     from './pages/MyPlaces'
import Login       from './pages/Login'
import ResetPassword from './pages/ResetPassword'
import AdminRecovery from './pages/AdminRecovery'
import AdminCodes    from './pages/AdminCodes'
import Loans from './pages/Loans'
import Account       from './pages/Account'
import Notifications from './pages/Notifications'
import Balances      from './pages/Balances'
import MasterGroupDetail from './pages/MasterGroupDetail'
import FriendDetail      from './pages/FriendDetail'
import Recommend         from './pages/Recommend'
import { UserContext, isAdmin } from './UserContext'

const SESSION_KEY = 'splitter_session_v2'

function getStoredUser() {
  try {
    const s = localStorage.getItem(SESSION_KEY)
    if (!s) return null
    const u = JSON.parse(s)
    // A session without a token can't authorise anything, so treat it as
    // signed out. Sessions saved before tokens existed land here and are
    // asked to sign in again, rather than showing an app where every
    // request fails.
    return u?.name && u?.token ? u : null
  } catch { return null }
}

export default function App() {
  const [user, setUser] = useState(getStoredUser)

  const handleLogout = () => {
    localStorage.clear()
    window.location.reload()
  }

  // Logged out, the only routed page is the password reset — everything else
  // falls through to the login screen.
  if (!user) {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/admin-recovery" element={<AdminRecovery />} />
          <Route path="*" element={<Login onLogin={setUser} />} />
        </Routes>
      </BrowserRouter>
    )
  }

  return (
    <UserContext.Provider value={user}>
      <BrowserRouter>
        {/* Keyed on who is signed in, so switching accounts throws the whole
            tree away and rebuilds it. Belt and braces next to the server's
            no-store headers: nothing rendered for the previous person can
            survive into the next person's session. */}
        {/* On phones the app is exactly the visible screen tall and only the
            content area scrolls - the page itself never does, so the bottom
            nav is an ordinary block under it with nothing for Safari to
            reposition. Both earlier fixes moved with the page and floated:
            position:fixed pins to iOS's layout viewport, which drifts from
            the visible screen (keyboard, collapsing toolbars), and
            position:sticky lagged mid-screen during momentum scrolling.
            Desktop keeps normal page scrolling. */}
        <div key={user.name} className="flex h-[100dvh] overflow-hidden md:h-auto md:min-h-dvh md:overflow-visible bg-canvas">
          {/* Desktop sidebar */}
          <Sidebar user={user} onLogout={handleLogout} />

          {/* Main content — offset by sidebar width on desktop */}
          <div className="flex-1 min-w-0 md:ml-56 flex flex-col min-h-0 md:min-h-dvh">
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain md:overflow-visible">
            <div className="max-w-4xl mx-auto w-full">
              {/* Above every page, so "did this payment arrive?" can't be
                  missed whichever screen the payee happens to be on. */}
              <PaymentClaimsInbox />
              <Routes>
                <Route path="/"           element={<Home />} />
                <Route path="/groups"     element={<Groups />} />
                <Route path="/groups/new"     element={<NewGroup />} />
                <Route path="/groups/monthly" element={<MonthlyGroup />} />
                <Route path="/groups/:id" element={<GroupDetail />} />
                <Route path="/groups/:id/edit" element={<EditGroup />} />
                <Route path="/add"        element={<AddExpense />} />
                <Route path="/recommend"  element={<Recommend />} />
                <Route path="/history"    element={<History />} />
                <Route path="/ml-analysis" element={<MLAnalysis />} />
                <Route path="/insights" element={<Insights />} />
                <Route path="/credit-cards/card/:id" element={<CardBill />} />
                <Route path="/food/places" element={<MyPlaces />} />
                <Route path="/master/:key" element={<MasterGroupDetail />} />
                <Route path="/friends/:name" element={<FriendDetail />} />
                <Route path="/account" element={<Account />} />
                <Route path="/loans" element={<Loans />} />
                <Route path="/notifications" element={<Notifications />} />
                <Route path="/balances/:kind" element={<Balances />} />
                {/* Admin-only: the route simply does not exist for others */}
                {isAdmin(user) && (
                  <Route path="/admin/codes" element={<AdminCodes />} />
                )}
              </Routes>
            </div>
            </div>

            {/* Mobile bottom nav - the last block of the screen-tall column,
                below the scrolling content (see the comment above). */}
            <BottomNav user={user} onLogout={handleLogout} />
          </div>
        </div>
      </BrowserRouter>
    </UserContext.Provider>
  )
}
