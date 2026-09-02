import { NavLink } from 'react-router-dom'
import { isAdmin } from '../UserContext'

function HomeIcon()    { return <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0h6" /></svg> }
function AddIcon()     { return <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg> }
function GlassIcon()   { return <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8 21h8m-4 0v-6m-6.5-11h13l-1.2 6.2A5 5 0 0 1 12.4 14h-.8a5 5 0 0 1-4.9-3.8L5.5 4z" /></svg> }
function FriendsIcon() { return <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14c-4.418 0-8 2.239-8 5v1h16v-1c0-2.761-3.582-5-8-5z" /></svg> }
function HistoryIcon() { return <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg> }

const items = [
  { to: '/',        label: 'Home',        icon: HomeIcon,    exact: true },
  { to: '/recommend', label: 'Recommend', icon: GlassIcon,  exact: false, highlight: true },
  { to: '/add',     label: 'Add Expense', icon: AddIcon,     exact: false },
  { to: '/friends', label: 'Friends',     icon: FriendsIcon, exact: false },
  { to: '/history', label: 'History',     icon: HistoryIcon, exact: false },
]

export default function Sidebar({ user, onLogout }) {
  return (
    <aside className="hidden md:flex flex-col fixed left-0 top-0 h-screen w-56 bg-field-950 border-r border-field-800 z-40">
      {/* Logo */}
      <div className="px-5 py-6 border-b border-field-800">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-brand-400 rounded-md flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h11M9 21V3m0 0l-3 3m3-3l3 3M14 14h7m-3.5-3.5L21 14l-3.5 3.5" />
            </svg>
          </div>
          <div>
            <p className="text-base font-bold text-white leading-tight tracking-tight">Splitter</p>
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
              `flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-semibold transition-all ${
                highlight
                  ? 'bg-brand-400 text-white shadow-md shadow-brand-400/30'
                  : isActive
                  ? 'bg-field-800 text-brand-400'
                  : 'text-slate-300/60 hover:bg-field-800 hover:text-white'
              }`
            }
          >
            <Icon />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* User + logout */}
      <div className="px-4 py-4 border-t border-field-800 space-y-2">
        {user && (
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-brand-400/20 border border-brand-400/30 rounded-md flex items-center justify-center text-brand-400 text-xs font-black flex-shrink-0">
              {user.name[0]?.toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-white truncate">{user.name}</p>
              <p className="text-xs text-slate-300/50 font-medium">{user.key}</p>
            </div>
          </div>
        )}
        {isAdmin(user) && (
          <NavLink
            to="/admin/codes"
            className="block w-full text-left text-xs text-slate-300/50 hover:text-brand-400 font-semibold transition-colors tracking-widest py-1"
          >
            One-time codes
          </NavLink>
        )}
        <NavLink
          to="/account"
          className="block w-full text-left text-xs text-slate-300/50 hover:text-brand-400 font-semibold transition-colors tracking-widest py-1"
        >
          Account & security
        </NavLink>
        <button
          onClick={onLogout}
          className="w-full text-left text-xs text-slate-300/50 hover:text-red-400 font-semibold transition-colors tracking-widest py-1"
        >
          Sign out
        </button>
      </div>
    </aside>
  )
}
