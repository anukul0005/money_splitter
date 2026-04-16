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

export default function App() {
  return (
    <BrowserRouter>
      <div className="flex min-h-screen bg-field-900">
        {/* Desktop sidebar */}
        <Sidebar />

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
        <BottomNav />
      </div>
    </BrowserRouter>
  )
}
