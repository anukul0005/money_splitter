import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getUnreadCount } from '../api'

/**
 * Bell with an unread badge. Navigates to the full /notifications page —
 * the feed is a page, not a dropdown preview.
 */
export default function NotificationBell({ user }) {
  const nav = useNavigate()
  const [unread, setUnread] = useState(0)

  useEffect(() => {
    if (!user?.name) return
    getUnreadCount(user.name)
      .then((r) => setUnread(r.data.count ?? 0))
      .catch(() => setUnread(0))
  }, [user?.name])

  return (
    <button
      onClick={() => nav('/notifications')}
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
      className="relative flex-shrink-0 p-2 -mr-1 text-white/70 hover:text-white active:scale-95 transition-all"
    >
      <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
      </svg>
      {unread > 0 && (
        <span className="absolute top-0.5 right-0.5 min-w-[18px] h-[18px] px-1 bg-brand-400 text-white text-[10px] font-bold rounded-full flex items-center justify-center ring-2 ring-field-950">
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </button>
  )
}
