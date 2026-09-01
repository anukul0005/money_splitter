import axios from 'axios'

const BASE = import.meta.env.VITE_API_URL || '/api'

const api = axios.create({ baseURL: BASE })

// ── Auth ──────────────────────────────────────────────────────────────────────
export const loginUser      = (data)        => api.post('/users/login', data)
export const signupUser     = (data)        => api.post('/users/signup', data)
export const listUsers      = ()            => api.get('/users/')
export const changePassword = (id, data)   => api.patch(`/users/${id}/password`, data)

// ── Password recovery ─────────────────────────────────────────────────────────
// A user who set a recovery question can reset from /reset-password on their
// own; anyone who hasn't needs an admin, who uses the same page.
export const setRecovery        = (id, data) => api.patch(`/users/${id}/recovery`, data)
export const getRecoveryQuestion = (name)    => api.get('/users/recovery-question', { params: { name } })
export const resetPassword      = (data)     => api.post('/users/reset-password', data)
export const adminResetPassword = (data)     => api.post('/users/admin-reset', data)
export const adminSetRecovery   = (data)     => api.post('/users/admin-set-recovery', data)
export const listUsersBasic     = ()         => api.get('/users/')
// One-time codes: an admin mints one for another user; that user spends it to
// set a new password and their own security question.
export const adminIssueCode     = (data)     => api.post('/users/admin-issue-code', data)
export const redeemCode         = (data)     => api.post('/users/redeem-code', data)

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
export const deleteExpense = (id, by)    => api.delete(`/expenses/${id}`, { params: by ? { by } : {} })

// ── Settlements ───────────────────────────────────────────────────────────────
export const getSettlement = (groupId)   => api.get(`/settlements/${groupId}`)

// ── Payments ──────────────────────────────────────────────────────────────────
// Recording a payment pays down what one member owes another; enough of them
// and the pair is settled. Replaces the old per-expense "mark settled" flag.
export const getPayments    = (groupId)  => api.get(`/payments/group/${groupId}`)
export const createPayment  = (data)     => api.post('/payments/', data)
// No group_id — the server places it against the outstanding debt
export const createPaymentAuto = (data)  => api.post('/payments/auto', data)
export const deletePayment  = (id)       => api.delete(`/payments/${id}`)
export const paymentsBetween = (a, b)    => api.get('/payments/between', { params: { a, b, viewer: a } })

// ── Activity feed ─────────────────────────────────────────────────────────────
export const getActivity      = (name, limit = 40) => api.get('/activity/', { params: { name, limit } })
export const getUnreadCount   = (name)   => api.get('/activity/unread-count', { params: { name } })
export const markActivitySeen = (name)   => api.post('/activity/seen', null, { params: { name } })

// ── Stats ─────────────────────────────────────────────────────────────────────
export const getGroupStats      = (groupId) => api.get(`/stats/${groupId}`)
export const getOverview        = ()        => api.get('/stats/overview/all')
export const getUserSummary     = (name)    => api.get('/stats/user-summary', { params: { name } })
export const getGlobalAnalytics     = (name) => api.get('/stats/global-analytics', { params: name ? { name } : {} })
export const getUserGroupBalances   = (name) => api.get('/stats/user-group-balances', { params: { name } })
export const getFriends             = (name) => api.get('/stats/friends', { params: { name } })
