import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import ChangePasswordModal from './ChangePasswordModal'

const items = [
  { to: '/',        label: 'Home',    icon: HomeIcon },
  { to: '/groups',  label: 'Groups',  icon: GroupIcon },
  { to: '/add',     label: 'Add',     icon: AddIcon, highlight: true },
  { to: '/history', label: 'History', icon: HistoryIcon },
]

function HomeIcon()    { return <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0h6" /></svg> }
function GroupIcon()   { return <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m9-4.13a4 4 0 11-8 0 4 4 0 018 0zm6 0a4 4 0 11-8 0 4 4 0 018 0z" /></svg> }
function AddIcon()     { return <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg> }
function HistoryIcon() { return <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg> }

export default function BottomNav({ user, onLogout }) {
  const [menuOpen, setMenuOpen]     = useState(false)
  const [showChangePw, setShowChangePw] = useState(false)

  const handleLogout = () => {
    setMenuOpen(false)
    if (window.confirm('Sign out?')) onLogout()
  }

  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-field-950 border-t border-field-800 pb-safe z-50 md:hidden">
      <div className="flex items-center justify-around h-16 px-2">
        {items.map(({ to, label, icon: Icon, highlight }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex flex-col items-center gap-0.5 flex-1 py-2 transition-colors ${
                highlight ? 'text-gray-900' : isActive ? 'text-brand-400' : 'text-green-200/40'
              }`
            }
          >
            {({ isActive }) =>
              highlight ? (
                <span className="bg-brand-400 p-2 -mt-5 shadow-lg shadow-brand-400/40 ring-4 ring-field-950">
                  <Icon />
                </span>
              ) : (
                <>
                  <Icon />
                  <span className={`text-[10px] font-semibold ${isActive ? 'text-brand-400' : 'text-green-200/40'}`}>
                    {label}
                  </span>
                </>
              )
            }
          </NavLink>
        ))}

        {/* User menu */}
        <div className="relative flex-1">
          <button
            onClick={() => setMenuOpen(v => !v)}
            className="flex flex-col items-center gap-0.5 w-full py-2 text-green-200/40 active:scale-95 transition-transform"
          >
            <span className="w-6 h-6 bg-brand-400/15 border border-brand-400/30 flex items-center justify-center font-black text-brand-400 text-xs">
              {user?.name?.[0]?.toUpperCase() || '?'}
            </span>
            <span className="text-[10px] font-semibold text-green-200/40">Account</span>
          </button>

          {menuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
              <div className="absolute bottom-14 right-0 bg-field-900 border border-field-700 shadow-xl z-50 w-44 py-1">
                <button
                  onClick={() => { setMenuOpen(false); setShowChangePw(true) }}
                  className="w-full text-left px-4 py-2.5 text-xs font-semibold text-green-200/60 hover:text-brand-400 hover:bg-field-800 transition-colors"
                >
                  Change password
                </button>
                <button
                  onClick={handleLogout}
                  className="w-full text-left px-4 py-2.5 text-xs font-semibold text-green-200/60 hover:text-red-400 hover:bg-field-800 transition-colors"
                >
                  Sign out
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      {showChangePw && <ChangePasswordModal user={user} onClose={() => setShowChangePw(false)} />}
    </nav>
  )
}
