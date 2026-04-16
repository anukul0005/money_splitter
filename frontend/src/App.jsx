import { BrowserRouter, Routes, Route } from 'react-router-dom'
import BottomNav from './components/BottomNav'
import Home        from './pages/Home'
import Groups      from './pages/Groups'
import GroupDetail from './pages/GroupDetail'
import AddExpense  from './pages/AddExpense'
import NewGroup    from './pages/NewGroup'
import History     from './pages/History'

export default function App() {
  return (
    <BrowserRouter>
      <div className="max-w-lg mx-auto min-h-screen relative">
        <Routes>
          <Route path="/"                element={<Home />} />
          <Route path="/groups"          element={<Groups />} />
          <Route path="/groups/new"      element={<NewGroup />} />
          <Route path="/groups/:id"      element={<GroupDetail />} />
          <Route path="/add"             element={<AddExpense />} />
          <Route path="/history"         element={<History />} />
        </Routes>
        <BottomNav />
      </div>
    </BrowserRouter>
  )
}
