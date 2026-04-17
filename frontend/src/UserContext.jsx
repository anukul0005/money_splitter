import { createContext, useContext } from 'react'

export const UserContext = createContext(null)
export const useUser = () => useContext(UserContext)

/** Names of admin users (case-insensitive). Admins see all groups. */
export const ADMIN_NAMES = ['anukul', 'anubhav']

export const isAdmin = (user) =>
  user ? ADMIN_NAMES.includes(user.name?.toLowerCase()) : false
