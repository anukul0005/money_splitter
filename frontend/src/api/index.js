import axios from 'axios'

const BASE = import.meta.env.VITE_API_URL || '/api'

const api = axios.create({ baseURL: BASE })

// ── Auth ──────────────────────────────────────────────────────────────────────
export const loginUser      = (data)        => api.post('/users/login', data)
export const signupUser     = (data)        => api.post('/users/signup', data)
export const listUsers      = ()            => api.get('/users/')
export const changePassword = (id, data)   => api.patch(`/users/${id}/password`, data)

// ── Groups ────────────────────────────────────────────────────────────────────
export const getGroups   = ()            => api.get('/groups/')
export const getGroup    = (id)          => api.get(`/groups/${id}`)
export const createGroup = (data)        => api.post('/groups/', data)
export const updateGroup = (id, data)    => api.patch(`/groups/${id}`, data)
export const deleteGroup = (id)          => api.delete(`/groups/${id}`)

// ── Expenses ──────────────────────────────────────────────────────────────────
export const getExpenses   = (groupId)   => api.get(`/expenses/group/${groupId}`)
export const createExpense = (data)      => api.post('/expenses/', data)
export const updateExpense = (id, data)  => api.put(`/expenses/${id}`, data)
export const deleteExpense = (id)        => api.delete(`/expenses/${id}`)
export const settleExpense = (id, data)  => api.patch(`/expenses/${id}/settle`, data)

// ── Settlements ───────────────────────────────────────────────────────────────
export const getSettlement = (groupId)   => api.get(`/settlements/${groupId}`)

// ── Stats ─────────────────────────────────────────────────────────────────────
export const getGroupStats      = (groupId) => api.get(`/stats/${groupId}`)
export const getOverview        = ()        => api.get('/stats/overview/all')
export const getUserSummary     = (name)    => api.get('/stats/user-summary', { params: { name } })
export const getGlobalAnalytics     = (name) => api.get('/stats/global-analytics', { params: name ? { name } : {} })
export const getUserGroupBalances   = (name) => api.get('/stats/user-group-balances', { params: { name } })
