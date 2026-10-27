import { createContext, useContext } from 'react'

export const UserContext = createContext(null)
export const useUser = () => useContext(UserContext)

/** Re-reads the signed-in user from the server (after unlocking access, say). */
export const RefreshUserContext = createContext(async () => {})
export const useRefreshUser = () => useContext(RefreshUserContext)

/** Names of admin users (case-insensitive). Admins see all groups. */
export const ADMIN_NAMES = ['anukul', 'anubhav']

export const isAdmin = (user) =>
  user ? ADMIN_NAMES.includes(user.name?.toLowerCase()) : false

/** The drinks side of the app (backend models.User.full_access): only for
 *  people given full access by an admin's code - and admins. Everyone else
 *  never sees it, or any mention of it. */
export const hasFullAccess = (user) => !!user?.has_full_access || isAdmin(user)

/** Betting analytics is Anukul's alone (backend routers/tennis.ANALYTICS_USERS). */
export const isAnalyticsUser = (user) => user?.name?.toLowerCase() === 'anukul'
