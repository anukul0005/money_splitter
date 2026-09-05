import axios from 'axios'

const BASE = import.meta.env.VITE_API_URL || '/api'

const api = axios.create({ baseURL: BASE })

// ── Session token ─────────────────────────────────────────────────────────────
// The backend identifies the caller from this token and nothing else. It used
// to trust a `name` query parameter, which meant anyone could read anyone
// else's data by typing their name.
const SESSION_KEY = 'splitter_session_v2'

export function getToken() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || '{}').token || ''
  } catch { return '' }
}

api.interceptors.request.use((config) => {
  const t = getToken()
  if (t) config.headers.Authorization = `Bearer ${t}`
  return config
})

// An expired or missing token means the stored session is useless — clear it
// and show the login screen rather than leaving a half-broken page up.
//
// Only this exact message signs you out. 401 also means "wrong password",
// "wrong passkey" and "wrong one-time code", and treating those the same way
// logged an admin out the moment they mistyped their passkey while issuing a
// code — the one screen where being logged in matters most.
const SESSION_EXPIRED = 'Sign in to continue'

api.interceptors.response.use(
  (r) => r,
  (err) => {
    const sessionGone =
      err.response?.status === 401 && err.response?.data?.detail === SESSION_EXPIRED
    if (sessionGone && getToken()) {
      localStorage.removeItem(SESSION_KEY)
      window.location.reload()
    }
    return Promise.reject(err)
  }
)

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
export const deleteExpense = (id)        => api.delete(`/expenses/${id}`)

// ── Settlements ───────────────────────────────────────────────────────────────
export const getSettlement = (groupId)   => api.get(`/settlements/${groupId}`)

// ── Payments ──────────────────────────────────────────────────────────────────
// Recording a payment pays down what one member owes another; enough of them
// and the pair is settled. Replaces the old per-expense "mark settled" flag.
export const getPayments    = (groupId)  => api.get(`/payments/group/${groupId}`)
export const createPayment  = (data)     => api.post('/payments/', data)
// No group_id — the server places it against the outstanding debt
export const createPaymentAuto = (data)  => api.post('/payments/auto', data)
// Editing a payment re-derives every balance it touches — nothing is stored
export const updatePayment  = (id, data) => api.put(`/payments/${id}`, data)
export const deletePayment  = (id)       => api.delete(`/payments/${id}`)
// `a` is ignored: the viewer is whoever the token says it is
export const paymentsBetween = (a, b)    => api.get('/payments/between', { params: { b } })

// ── Activity feed ─────────────────────────────────────────────────────────────
export const getActivity      = (name, limit = 40) => api.get('/activity/', { params: { limit } })
export const getUnreadCount   = (name)   => api.get('/activity/unread-count')
export const markActivitySeen = (name)   => api.post('/activity/seen')

// ── Stats ─────────────────────────────────────────────────────────────────────
export const getGroupStats      = (groupId) => api.get(`/stats/${groupId}`)
// Combined stats across a master group's set of groups
export const getAggregateStats  = (ids)     => api.get('/stats/aggregate', { params: { ids: ids.join(',') } })
export const getOverview        = ()        => api.get('/stats/overview/all')
export const getUserSummary     = (name)    => api.get('/stats/user-summary')
export const getGlobalAnalytics     = (name) => api.get('/stats/global-analytics')
export const getUserGroupBalances   = (name) => api.get('/stats/user-group-balances')
export const getFriends             = (name) => api.get('/stats/friends')

// ── Drink recommender ─────────────────────────────────────────────────────────
// Prices come from scraped state excise listings; history from your own spend.
export const getRecommendMeta = ()      => api.get('/recommend/meta')
export const getRecommendation = (p)    => api.get('/recommend/', { params: p })
export const searchRecommend   = (p)    => api.get('/recommend/search', { params: p })

// ── Food recommender ──────────────────────────────────────────────────────────
// Same idea, different table: cited Delhi NCR restaurant listings priced the
// way listings price them (cost for two), plus your own eating-out history.
export const getFoodMeta       = ()     => api.get('/food/meta')
export const getFoodRecommendation = (p) => api.get('/food/', { params: p })
export const searchFood        = (p)    => api.get('/food/search', { params: p })
export const listPlaceNames    = (city) => api.get('/food/names', { params: { city } })

// ── Corrections people enter by hand ──────────────────────────────────────────
// Published lists are a starting point, not the last word: a shop charges above
// the state minimum, a restaurant raises its prices, a place is in no listing at
// all. These layer over the tables so the app improves as it gets used.
export const listPrices   = (state) => api.get('/recommend/prices', { params: { state } })
export const listBrands   = (state) => api.get('/recommend/brands', { params: { state } })
export const savePrice    = (body)  => api.post('/recommend/prices', body)
export const deletePrice  = (id)    => api.delete(`/recommend/prices/${id}`)

export const listPlaces   = (city)  => api.get('/food/places', { params: { city } })
export const savePlace    = (body)  => api.post('/food/places', body)
export const deletePlace  = (id)    => api.delete(`/food/places/${id}`)
