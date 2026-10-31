import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { isAdmin, isAnalyticsUser } from '../UserContext'

// Adding an expense is one tap from Home's quick actions and from "+ Add"
// inside any group, so the bar is just the main pages, all alike.
const items = [
  { to: '/',          label: 'Home',      icon: HomeIcon },
  { to: '/recommend', label: 'Recommend', icon: CompassIcon },
  { to: '/history',   label: 'History',   icon: HistoryIcon },
]

function HomeIcon()    { return <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0h6" /></svg> }
// A cocktail glass said "drinks", and the key now opens food as well. A
// compass reads as "find something" without picking a side between the two.
function CompassIcon() { return <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 9l-2 6-6 2 2-6 6-2z" /></svg> }
function HistoryIcon() { return <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg> }

export default function BottomNav({ user, onLogout }) {
  const [menuOpen, setMenuOpen]     = useState(false)

  const handleLogout = () => {
    setMenuOpen(false)
    if (window.confirm('Sign out?')) onLogout()
  }

  return (
    // A plain block at the foot of the app's screen-tall column (App.jsx):
    // the page never scrolls, so there's nothing for it to float with.
    <nav className="flex-shrink-0 w-full bg-field-950 border-t border-field-800 pb-safe z-50 md:hidden">
      <div className="flex items-center justify-around h-16 px-2">
        {items.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex flex-col items-center gap-0.5 flex-1 py-2 transition-colors ${
                isActive ? 'text-brand-400' : 'text-slate-300/40'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <Icon />
                <span className={`text-[10px] font-semibold ${isActive ? 'text-brand-400' : 'text-slate-300/40'}`}>
                  {label}
                </span>
              </>
            )}
          </NavLink>
        ))}

        {/* User menu */}
        <div className="relative flex-1">
          <button
            onClick={() => setMenuOpen(v => !v)}
            className="flex flex-col items-center gap-0.5 w-full py-2 text-slate-300/40 active:scale-95 transition-transform"
          >
            <span className="w-6 h-6 bg-brand-400/15 border border-brand-400/30 rounded flex items-center justify-center font-black text-brand-400 text-xs">
              {user?.name?.[0]?.toUpperCase() || '?'}
            </span>
            <span className="text-[10px] font-semibold text-slate-300/40">Account</span>
          </button>

          {menuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
              <div className="absolute bottom-14 right-0 bg-field-900 border border-field-700 rounded-md shadow-xl z-50 w-44 py-1">
                {isAnalyticsUser(user) && (
                  <NavLink
                    to="/betting"
                    onClick={() => setMenuOpen(false)}
                    className="block w-full text-left px-4 py-2.5 text-xs font-semibold text-slate-300/60 hover:text-brand-400 hover:bg-field-800 transition-colors"
                  >
                    Betting analytics
                  </NavLink>
                )}
                {isAnalyticsUser(user) && (
                  <NavLink
                    to="/tennis/news"
                    onClick={() => setMenuOpen(false)}
                    className="block w-full text-left px-4 py-2.5 text-xs font-semibold text-slate-300/60 hover:text-brand-400 hover:bg-field-800 transition-colors"
                  >
                    Sports news
                  </NavLink>
                )}
                {isAdmin(user) && (
                  <NavLink
                    to="/admin/codes"
                    onClick={() => setMenuOpen(false)}
                    className="block w-full text-left px-4 py-2.5 text-xs font-semibold text-slate-300/60 hover:text-brand-400 hover:bg-field-800 transition-colors"
                  >
                    One-time codes
                  </NavLink>
                )}
                <NavLink
                  to="/account"
                  onClick={() => setMenuOpen(false)}
                  className="block w-full text-left px-4 py-2.5 text-xs font-semibold text-slate-300/60 hover:text-brand-400 hover:bg-field-800 transition-colors"
                >
                  Account & security
                </NavLink>
                <button
                  onClick={handleLogout}
                  className="w-full text-left px-4 py-2.5 text-xs font-semibold text-slate-300/60 hover:text-red-400 hover:bg-field-800 transition-colors"
                >
                  Sign out
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </nav>
  )
}
