import { NavLink } from 'react-router-dom'

function HomeIcon()    { return <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0h6" /></svg> }
function GroupIcon()   { return <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m9-4.13a4 4 0 11-8 0 4 4 0 018 0zm6 0a4 4 0 11-8 0 4 4 0 018 0z" /></svg> }
function AddIcon()     { return <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg> }
function HistoryIcon() { return <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg> }

const items = [
  { to: '/',        label: 'Home',        icon: HomeIcon,    exact: true },
  { to: '/groups',  label: 'Groups',      icon: GroupIcon,   exact: false },
  { to: '/add',     label: 'Add Expense', icon: AddIcon,     exact: false, highlight: true },
  { to: '/history', label: 'History',     icon: HistoryIcon, exact: false },
]

export default function Sidebar() {
  return (
    <aside className="hidden md:flex flex-col fixed left-0 top-0 h-screen w-56 bg-white border-r border-gray-100 z-40">
      {/* Logo */}
      <div className="px-5 py-6 border-b border-gray-50">
        <div className="flex items-center gap-2">
          <span className="text-2xl">💰</span>
          <div>
            <p className="text-base font-bold text-gray-900 leading-tight">Splitter</p>
            <p className="text-xs text-gray-400">Group expenses</p>
          </div>
        </div>
      </div>

      {/* Nav links */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {items.map(({ to, label, icon: Icon, exact, highlight }) => (
          <NavLink
            key={to}
            to={to}
            end={exact}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                highlight
                  ? 'bg-brand-600 text-white shadow-sm hover:bg-brand-700'
                  : isActive
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-gray-500 hover:bg-gray-50 hover:text-gray-800'
              }`
            }
          >
            <Icon />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-5 py-4 border-t border-gray-50">
        <p className="text-xs text-gray-300">Money Splitter v1.0</p>
      </div>
    </aside>
  )
}
