import { useState } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import BottomNav  from './components/BottomNav'
import Sidebar    from './components/Sidebar'
import Home        from './pages/Home'
import Groups      from './pages/Groups'
import GroupDetail from './pages/GroupDetail'
import AddExpense  from './pages/AddExpense'
import NewGroup    from './pages/NewGroup'
import EditGroup   from './pages/EditGroup'
import History     from './pages/History'
import Login       from './pages/Login'
import { UserContext } from './UserContext'

const SESSION_KEY = 'splitter_session'
const ADMIN_NAMES = ['anukul', 'anubhav']

// One-time migration: wipe all non-admin user accounts (groups/expenses untouched)
if (!localStorage.getItem('splitter_migration_clear_users_v1')) {
  localStorage.removeItem('splitter_users_v2')
  localStorage.removeItem('splitter_users_v3')
  // Clear session only if it belongs to a non-admin
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null')
    if (s && !ADMIN_NAMES.includes(s.name?.toLowerCase())) {
      localStorage.removeItem(SESSION_KEY)
    }
  } catch { localStorage.removeItem(SESSION_KEY) }
  localStorage.setItem('splitter_migration_clear_users_v1', '1')
}

function getStoredUser() {
  try {
    const s = localStorage.getItem(SESSION_KEY)
    if (!s) return null
    const u = JSON.parse(s)
    return u?.name ? u : null
  } catch { return null }
}

export default function App() {
  const [user, setUser] = useState(getStoredUser)

  const handleLogout = () => {
    localStorage.removeItem(SESSION_KEY)
    setUser(null)
  }

  if (!user) return <Login onLogin={setUser} />

  return (
    <UserContext.Provider value={user}>
      <BrowserRouter>
        <div className="flex min-h-screen bg-field-900">
          {/* Desktop sidebar */}
          <Sidebar user={user} onLogout={handleLogout} />

          {/* Main content — offset by sidebar width on desktop */}
          <div className="flex-1 min-w-0 md:ml-56">
            <div className="max-w-4xl mx-auto">
              <Routes>
                <Route path="/"           element={<Home />} />
                <Route path="/groups"     element={<Groups />} />
                <Route path="/groups/new" element={<NewGroup />} />
                <Route path="/groups/:id" element={<GroupDetail />} />
                <Route path="/groups/:id/edit" element={<EditGroup />} />
                <Route path="/add"        element={<AddExpense />} />
                <Route path="/history"    element={<History />} />
              </Routes>
            </div>
          </div>

          {/* Mobile bottom nav */}
          <BottomNav user={user} onLogout={handleLogout} />
        </div>
      </BrowserRouter>
    </UserContext.Provider>
  )
}
