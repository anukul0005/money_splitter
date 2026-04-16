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
    <aside className="hidden md:flex flex-col fixed left-0 top-0 h-screen w-56 bg-field-950 border-r border-field-800 z-40">
      {/* Logo */}
      <div className="px-5 py-6 border-b border-field-800">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-brand-400 flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-gray-900" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h11M9 21V3m0 0l-3 3m3-3l3 3M14 14h7m-3.5-3.5L21 14l-3.5 3.5" />
            </svg>
          </div>
          <div>
            <p className="text-base font-black text-white leading-tight tracking-tight">SPLITTER</p>
            <p className="text-xs text-brand-400/70">Group expenses</p>
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
              `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                highlight
                  ? 'bg-brand-400 text-gray-900 shadow-md shadow-brand-400/30'
                  : isActive
                  ? 'bg-field-800 text-brand-400'
                  : 'text-green-200/60 hover:bg-field-800 hover:text-white'
              }`
            }
          >
            <Icon />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-5 py-4 border-t border-field-800">
        <p className="text-xs text-green-200/20 font-medium tracking-wide">MONEY SPLITTER v1.0</p>
      </div>
    </aside>
  )
}
