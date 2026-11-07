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
export const adminIssueAccessCode = (data)   => api.post('/users/admin-issue-access-code', data)
export const requestFullAccess  = ()         => api.post('/users/me/access-request')
export const unlockFullAccess   = (code)     => api.post('/users/me/unlock', { code })
export const setFullName        = (full_name) => api.post('/users/me/full-name', { full_name })
export const redeemCode         = (data)     => api.post('/users/redeem-code', data)
export const requestLoginCode   = (data)     => api.post('/users/email-code', data)
export const verifyLoginCode    = (data)     => api.post('/users/email-code/verify', data)
export const setMyEmail         = (data)     => api.post('/users/me/email', data)
export const setMyBirthday      = (data)     => api.post('/users/me/birthday', data)
export const setMyDailySummary  = (enabled)  => api.post('/users/me/daily-summary', { enabled })
export const setMyNewsAlerts    = (sport, enabled) => api.post('/users/me/news-alerts', { sport, enabled })
// Admin: who sees the drinks side (Recommend's Drinks, the party forecast)
export const listDrinksAccess   = ()          => api.get('/users/admin/drinks-access')
export const listNewMembers     = (limit = 10) => api.get('/users/admin/new-members', { params: { limit } })
export const setDrinksAccess    = (name, enabled) => api.post('/users/admin/drinks-access', { name, enabled })
export const setMySalary        = (data)     => api.post('/users/me/salary', data)
// multipart, not JSON - axios sets the right Content-Type + boundary on
// its own once it sees a FormData body, so nothing is set here by hand.
// A handwritten page of shared expenses -> rows to review -> expenses (routers/ledger.py)
export const readLedgerPage     = (groupId, file) => {
  const fd = new FormData()
  fd.append('group_id', groupId)
  fd.append('file', file)
  return api.post('/ledger/read', fd)
}
export const saveLedgerPage     = (body)     => api.post('/ledger/save', body)
export const saveLedgerBill     = (body)     => api.post('/ledger/save-bill', body)
export const scanReceipt        = (file)     => {
  const fd = new FormData()
  fd.append('file', file)
  return api.post('/receipts/scan', fd)
}
export const getMonthlySkipped  = (groupId)  => api.get(`/expenses/monthly/${groupId}/skipped`)
// A statement import as a background job, polled for a progress bar.
export const startImportJob     = (file, password, onUploadProgress, signal, remember = false) => {
  const fd = new FormData()
  fd.append('file', file)
  if (password) fd.append('password', password)
  if (password && remember) fd.append('remember', 'true')
  return api.post('/expenses/import-jobs', fd, { onUploadProgress, signal })
}
export const cancelImportJob    = (jobId)    => api.post(`/expenses/import-jobs/${jobId}/cancel`)
// Payment-app statements found in Gmail, imported the same way - polled with getImportJob.
export const startMailSync      = (password, remember = false, days = 4) => {
  const fd = new FormData()
  if (password) fd.append('password', password)
  if (password && remember) fd.append('remember', 'true')
  if (days) fd.append('days', String(days))
  return api.post('/expenses/mail-sync-jobs', fd)
}
// The statement sync's Gmail: inbox, last sync, and whether access has expired.
export const getMailSyncStatus  = ()         => api.get('/expenses/mail-sync-status')
// Remembered statement passwords - names in the list; a password only when Show is tapped.
export const listStatementPasswords  = ()    => api.get('/expenses/statement-passwords')
export const revealStatementPassword = (app) => api.get(`/expenses/statement-passwords/${encodeURIComponent(app)}/password`)
export const setStatementPassword    = (app, password) => api.put(`/expenses/statement-passwords/${encodeURIComponent(app)}`, { password })
export const forgetStatementPassword = (app) => api.delete(`/expenses/statement-passwords/${encodeURIComponent(app)}`)
export const getImportJob       = (jobId)    => api.get(`/expenses/import-jobs/${jobId}`)
export const getMe              = ()         => api.get('/users/me')
// ── UPI IDs (for "pay via UPI" QR / deep link) ──────────────────────────────────
export const listMyUpiIds       = ()         => api.get('/users/me/upi')
export const addUpiId           = (data)     => api.post('/users/me/upi', data)
export const deleteUpiId        = (id)       => api.delete(`/users/me/upi/${id}`)
// Anyone's saved UPI IDs, by username - used to build a "pay them" button
// for someone you owe, the same way reading a UPI ID off their QR code would.
export const listUpiIdsFor      = (name)     => api.get(`/users/${encodeURIComponent(name)}/upi`)
// ── Payment claims: payer says "I've paid", payee confirms or rejects ─────────
// data: { payee, amount, kind: 'loan' | 'bill' | 'balance', ref_id?, note? }
export const createPaymentClaim = (data)     => api.post('/payment-claims/', data)
export const listIncomingClaims = ()         => api.get('/payment-claims/incoming')
export const listOutgoingClaims = ()         => api.get('/payment-claims/outgoing')
export const confirmClaim       = (id)       => api.post(`/payment-claims/${id}/confirm`)
export const rejectClaim        = (id)       => api.post(`/payment-claims/${id}/reject`)
export const cancelClaim        = (id)       => api.post(`/payment-claims/${id}/cancel`)
// ── Loans, borrowings and recurring shared bills ─────────────────────────────
export const getLoans          = ()          => api.get('/loans/')
export const createLoan        = (data)      => api.post('/loans/', data)
export const repayLoan         = (id, data)  => api.post(`/loans/${id}/payments`, data)
export const deleteLoan        = (id)        => api.delete(`/loans/${id}`)
export const createBill        = (data)      => api.post('/loans/bills', data)
export const markChargePaid    = (id)        => api.post(`/loans/bills/charges/${id}/paid`)
export const repayBill         = (id, data)  => api.post(`/loans/bills/${id}/repay`, data)
export const updateBillDay     = (id, data)  => api.patch(`/loans/bills/${id}`, data)
export const stopBill          = (id)        => api.delete(`/loans/bills/${id}`)
export const stopBillMember    = (id, member) => api.post(`/loans/bills/${id}/stop-member`, { member })

// ── Credit Cards (Gmail-connected statement scanning) ──────────────────────────
export const getGmailStatus     = ()          => api.get('/gmail/status')
export const getGmailConnectUrl = (purpose)   => api.get('/gmail/connect', { params: purpose ? { purpose } : {} })
export const disconnectGmail    = ()          => api.delete('/gmail/disconnect')
export const listCardBanks      = ()          => api.get('/credit-cards/banks')
export const setCardBankPassword = (data)     => api.post('/credit-cards/banks', data)
export const deleteCardBank     = (bank)      => api.delete(`/credit-cards/banks/${encodeURIComponent(bank)}`)
export const getCardBankOptions = ()          => api.get('/credit-cards/bank-options')
export const listCards          = ()          => api.get('/credit-cards/cards')
export const getCardInsights    = (month)     => api.get('/credit-cards/insights', { params: { month } })
export const addCard            = (data)      => api.post('/credit-cards/cards', data)
export const updateCard         = (id, data)  => api.put(`/credit-cards/cards/${id}`, data)
export const deleteCard         = (id)        => api.delete(`/credit-cards/cards/${id}`)
export const deleteCardBill     = (id)        => api.delete(`/credit-cards/bills/${id}`)
export const fetchCardBills     = (months)    => api.post('/credit-cards/fetch', null, { params: { months } })
export const recordCardPayment  = (id, data)  => api.post(`/credit-cards/bills/${id}/payments`, data)
export const deleteCardPayment  = (id)        => api.delete(`/credit-cards/payments/${id}`)
export const getCardBillDetails = (id)        => api.get(`/credit-cards/bills/${id}/details`)
export const readCardBillDetails = (id)       => api.post(`/credit-cards/bills/${id}/details`)
export const getCardCategories = ()           => api.get('/credit-cards/categories')
export const setCardLineCategory = (id, line, body) => api.post(`/credit-cards/bills/${id}/lines/${line}/category`, body)
export const fetchCardMonth     = (id, period) => api.post(`/credit-cards/cards/${id}/fetch-month`, null, { params: { period } })
export const getCardPassword    = (id)        => api.get(`/credit-cards/cards/${id}/password`)
export const setCardPassword    = (id, password) => api.put(`/credit-cards/cards/${id}/password`, { password })
export const revealBankPassword = (bank)      => api.get(`/credit-cards/banks/${encodeURIComponent(bank)}/password`)
export const getScanProgress    = ()          => api.get('/credit-cards/scan/progress')
// ── Push notifications ───────────────────────────────────────────────────────
export const getVapidPublicKey  = ()         => api.get('/push/vapid-public-key')
export const subscribePush      = (data)     => api.post('/push/subscribe', data)
export const unsubscribePush    = (data)     => api.post('/push/unsubscribe', data)

// ── Groups ────────────────────────────────────────────────────────────────────
export const getGroups   = ()            => api.get('/groups/')
export const getGroup    = (id)          => api.get(`/groups/${id}`)
export const createGroup = (data)        => api.post('/groups/', data)
export const updateGroup = (id, data)    => api.patch(`/groups/${id}`, data)
// force: also when the group holds a discussion (it's deleted with it) - the server refuses otherwise
export const deleteGroup = (id, force = false) => api.delete(`/groups/${id}`, { params: force ? { force: true } : {} })

// ── Expenses ──────────────────────────────────────────────────────────────────
export const getExpenses   = (groupId)   => api.get(`/expenses/group/${groupId}`)
export const createExpense = (data)      => api.post('/expenses/', data)
export const updateExpense = (id, data)  => api.put(`/expenses/${id}`, data)
export const deleteExpense = (id)        => api.delete(`/expenses/${id}`)
// Recommend's chat box (Drinks, Food): a message read into the page's settings, or a lookup answered from the data
export const understandRecommend = (data) => api.post('/ask/understand', data)
// Recipes (Recommend → Recipes): ask, plan, and your profile and kitchen
export const recipesMe     = ()       => api.get('/recipes/me')
export const saveRecipesMe = (data)   => api.put('/recipes/me', data)
export const askRecipes    = (question) => api.post('/recipes/ask', { question })
export const planRecipes   = (days = 7, diet = 'any') => api.post('/recipes/plan', { days, diet })
export const logMeal       = (data)   => api.post('/recipes/log', data)
export const unlogMeal     = (day, meal) => api.post('/recipes/log/remove', { day, meal })
export const reworkMeal    = (day, meal) => api.post('/recipes/log/rework', { day, meal })
export const fixMealItem   = (day, meal, index, kcal, protein) => api.post('/recipes/log/fix', { day, meal, index, kcal, protein })
export const recipeDish    =(name, servings = 1, recipe = null) => api.post('/recipes/dish', { name, servings, recipe })
// Add Expense's chat box and mic: a message read into the form's fields
export const understandExpense  = (data) => api.post('/expenses/understand', data)
export const transcribeExpense  = (blob) => {
  const fd = new FormData()
  const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'
  fd.append('file', blob, `speech.${ext}`)
  return api.post('/expenses/transcribe', fd)
}

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
export const getHistory         = ()        => api.get('/stats/history')
// Salary dashboard: pay vs spent / invested, month by month; hand-entered investments.
export const getSalaryDashboard = (months = 12) => api.get('/salary/dashboard', { params: { months } })
export const addInvestment      = (data)    => api.post('/salary/investments', data)
export const editInvestment     = (id, data) => api.put(`/salary/investments/${id}`, data)
export const deleteInvestment   = (id)      => api.delete(`/salary/investments/${id}`)
export const getSalaryItems     = (month, source) => api.get('/salary/items', { params: { month, source } })
// A card spend already counted elsewhere (a group, say): left out of the dashboard - or counted again
export const setCardSkip        = (key, counted) => api.post('/salary/card-skips', { key, counted })
// A monthly expense that was really money to a person / an investment - and undo
export const moveMonthlyExpense = (expenseId, kind, remember) => api.post('/salary/move', { expense_id: expenseId, kind, remember })
export const moveMonthlyBack    = (skipId, undo) => api.post('/salary/move-back', { skip_id: skipId, undo })
export const getPatterns        = ()        => api.get('/stats/patterns')
export const getMLAnalysis      = ()        => api.get('/stats/ml-analysis')
export const getPredictions     = (force = false) => api.get('/stats/predictions', { params: force ? { force } : {} })
export const getRecommendations = (force = false) => api.get('/stats/recommendations', { params: force ? { force } : {} })
export const getInsights        = ()        => api.get('/stats/insights')
export const sendNudge          = (name)    => api.post('/nudges', { name })
export const getRecentNudges    = ()        => api.get('/nudges/recent')
export const getInsightsVersion = ()        => api.get('/stats/insights/version')
export const setSavingsPlan     = (active)  => api.post('/stats/savings-plan', null, { params: { active } })
export const getAggregateStats  = (ids)     => api.get('/stats/aggregate', { params: { ids: ids.join(',') } })
export const getOverview        = ()        => api.get('/stats/overview/all')
export const getUserSummary     = (name)    => api.get('/stats/user-summary')
export const getUserGroupBalances   = (name) => api.get('/stats/user-group-balances')
export const getFriends             = (name) => api.get('/stats/friends')

// ── Drink recommender ─────────────────────────────────────────────────────────
// Prices come from scraped state excise listings; history from your own spend.
export const getRecommendMeta = ()      => api.get('/recommend/meta')
export const getRecommendation = (p)    => api.get('/recommend/', { params: p })
export const searchRecommend   = (p)    => api.get('/recommend/search', { params: p })
export const askRecommend      = (p)    => api.get('/recommend/ask', { params: p })
export const logRecommendShown = (body) => api.post('/recommend/events/shown', body)
export const getRecommendEventsSummary = (names) =>
  api.get('/recommend/events/summary', { params: { names } })

// ── Food recommender ──────────────────────────────────────────────────────────
// Same idea, different table: cited Delhi NCR restaurant listings priced the
// way listings price them (cost for two), plus your own eating-out history.
export const getFoodMeta       = ()     => api.get('/food/meta')
export const getFoodRecommendation = (p) => api.get('/food/', { params: p })
export const searchFood        = (p)    => api.get('/food/search', { params: p })
export const listPlaceNames    = (city) => api.get('/food/names', { params: { city } })
export const getMyPlaces       = ()     => api.get('/food/my-places')
export const getMyPlaceVisits  = (name) => api.get('/food/my-places/visits', { params: { name } })
// Betting analytics - ATP/WTA results 2000-today (backend routers/tennis.py; owner only)
// Betting analytics answers are kept a short while in memory: going back to a
// tab or a page just seen shows at once instead of asking the server again.
const memo = new Map()
const MIN = 60_000
function remembered(url, params, ttl) {
  const k = url + JSON.stringify(params || {})
  const hit = memo.get(k)
  if (hit && Date.now() - hit.t < ttl) return hit.p
  const p = api.get(url, { params }).then((r) => {
    if (r.data?.refreshing) memo.delete(k)       // still being worked out: ask again next time
    return r
  }).catch((e) => { memo.delete(k); throw e })
  memo.set(k, { t: Date.now(), p })
  if (memo.size > 200) memo.delete(memo.keys().next().value)
  return p
}

export const tennisSummary  = ()                 => remembered('/tennis/summary', null, 5 * MIN)
// Badminton - BWF live scores, results from 2018, players, stats (backend routers/badminton.py)
export const badmintonSummary     = ()               => remembered('/badminton/summary', null, MIN)
export const badmintonLive        = ()               => api.get('/badminton/live')
export const badmintonTournaments = (year)           => remembered('/badminton/tournaments', { year }, 5 * MIN)
export const badmintonTournament  = (id)             => remembered(`/badminton/tournament/${id}`, null, 2 * MIN)
export const badmintonMatch       = (tid, code, finished) => remembered(`/badminton/match/${tid}/${code}`, { finished }, finished ? 60 * MIN : 15_000)
export const badmintonDay         = (on) => remembered('/badminton/day', { on }, 2 * MIN)
export const badmintonGame        =(tid, code) => remembered(`/badminton/game/${tid}/${code}`, {}, 15_000)
export const badmintonPlayers     = (q)              => remembered('/badminton/players', { q }, 5 * MIN)
export const badmintonPlayer      = (id)             => remembered(`/badminton/player/${id}`, null, 5 * MIN)
export const badmintonH2H         = (a, b)           => remembered('/badminton/h2h', { a, b }, 5 * MIN)
export const badmintonRankings    = (event)          => remembered('/badminton/rankings', { event }, 60 * MIN)
export const badmintonStats       = (event, since)   => remembered('/badminton/stats', { event, since }, 10 * MIN)
// Hockey - FIH live scores, tournaments, standings, stats, rankings (backend routers/hockey.py)
export const hockeyLive     = ()                 => api.get('/hockey/live')
export const hockeyEvents   = (status, page)     => remembered('/hockey/events', { status, page }, 10 * MIN)
export const hockeyEvent    = (id)               => remembered(`/hockey/event/${id}`, null, 30_000)
export const hockeyStats    = (id)               => remembered(`/hockey/stats/${id}`, null, 5 * MIN)
export const hockeyH2H      = (matchId)          => remembered(`/hockey/h2h/${matchId}`, null, 60 * MIN)
export const hockeyRankings = (gender)           => remembered('/hockey/rankings', { gender }, 60 * MIN)
export const tennisNews     = (source, sport)    => api.get('/tennis/news', { params: { source, sport } })
export const tennisArticle  = (id)               => remembered(`/tennis/news/${id}`, null, 30 * MIN)
export const tennisDay      = (date, tour)       => remembered('/tennis/day', { date, tour }, 2 * MIN)
export const tennisPlayers  = (q, tour)          => remembered('/tennis/players', { q, tour }, 5 * MIN)
export const tennisPlayer   = (tour, id)         => remembered(`/tennis/player/${tour}/${id}`, null, 5 * MIN)
export const tennisH2H      = (tour, a, b)       => api.get('/tennis/h2h', { params: { tour, a, b } })
export const tennisLive     = (tour)             => remembered('/tennis/live', { tour }, 8_000)
export const tennisLivePoints = ()               => api.get('/tennis/live/points')
export const tennisLiveFeed = (espn)             => api.get('/tennis/live/feed', { params: { espn } })
export const tennisMatchup  = (params)           => remembered('/tennis/matchup', params, 2 * MIN)
export const tennisSets     = ()                 => remembered('/tennis/sets', null, 10 * MIN)
export const tennisRankings = (tour)             => remembered('/tennis/rankings', { tour }, 30 * MIN)
export const tennisPatterns = (since = 0)        => remembered('/tennis/patterns', { since }, 10 * MIN)
export const tennisEarlyBreak = ()              => remembered('/tennis/early-break', {}, 60 * MIN)

// My bets - 1xbet history read from Gmail (backend routers/bets.py; owner only)
export const betsStatus     = ()                 => api.get('/bets/status')
export const betsConnectUrl = ()                 => api.get('/gmail/connect', { params: { purpose: 'betting' } })
export const betsSync       = (password)         => api.post('/bets/sync', { password: password || null })
export const betsProgress   = ()                 => api.get('/bets/sync/progress')
export const betsSummary    = (params)           => api.get('/bets/summary', { params })
export const betsList       = (params)           => api.get('/bets/list', { params })
export const betsPromos     = ()                 => api.get('/bets/promos')
export const betsSavePromo  = (body)             => api.post('/bets/promos', body)
export const betsDeletePromo = (day)             => api.delete(`/bets/promos/${day}`)
export const tennisSetsTourney = (tour, name)    => remembered('/tennis/sets/tournament', { tour, name }, 10 * MIN)
// Bottles I've had - read from drink expenses' descriptions and notes (backend bottles.py)
export const getMyBottles      = ()     => api.get('/drinks/my-bottles')
export const getBottlePurchases = (name, size) => api.get('/drinks/my-bottles/purchases', { params: { name, size } })

// ── Forecast ───────────────────────────────────────────────────────────────────
// Two directions on the same question. /budget splits one total into a
// drinks share and a food share, using your own historical ratio between
// the two. /items goes the other way: told exactly what's being bought, it
// prices it out against the same cross-state catalogue /recommend uses.
export const getForecastBudget = (p)    => api.get('/forecast/budget', { params: p })
export const getForecastItems  = (body) => api.post('/forecast/items', body)

// ── Product reviews ──────────────────────────────────────────────────────────
// A real person's own opinion of a bottle - separate from the knowledge
// base's own rating/estimate, and averaged across everyone who has reviewed
// it. Submitting again updates your own review rather than adding a second.
export const getProductReviews = (productId)      => api.get(`/recommend/products/${productId}/reviews`)
export const submitProductReview = (productId, body) => api.post(`/recommend/products/${productId}/review`, body)

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

// ── Discussions: a group's planning threads, enquiries and quotes ───────────
export const listDiscussions    = ()           => api.get('/discussions')
export const createDiscussion   = (data)       => api.post('/discussions', data)
export const getDiscussion      = (id)         => api.get(`/discussions/${id}`)
export const editDiscussion     = (id, data)   => api.patch(`/discussions/${id}`, data)
export const deleteDiscussion   = (id)         => api.delete(`/discussions/${id}`)
export const postDiscussionMessage   = (id, data) => api.post(`/discussions/${id}/messages`, data)
export const deleteDiscussionMessage = (id, mid)  => api.delete(`/discussions/${id}/messages/${mid}`)
export const setDiscussionTask  = (id, tid, status) => api.post(`/discussions/${id}/tasks/${tid}`, { status })
export const addDiscussionQuote = (id, data)   => api.post(`/discussions/${id}/quotes`, data)
export const editDiscussionQuote   = (id, qid, data) => api.put(`/discussions/${id}/quotes/${qid}`, data)
export const deleteDiscussionQuote = (id, qid) => api.delete(`/discussions/${id}/quotes/${qid}`)
export const acceptDiscussionInvite = (token)  => api.post(`/discussions/invites/${encodeURIComponent(token)}/accept`)
export const polishMessage      = (data)       => api.post('/discussions/polish', data)
export const suggestQuoteFields = (data)       => api.post('/discussions/suggest-params', data)
export const createDiscussionPoll = (id, data)  => api.post(`/discussions/${id}/polls`, data)
export const voteDiscussionPoll   = (id, pid, choices, note) => api.post(`/discussions/${id}/polls/${pid}/vote`, { choices, note })
export const setDiscussionPollState = (id, pid, closed) => api.post(`/discussions/${id}/polls/${pid}/state`, { closed })
export const deleteDiscussionPoll = (id, pid)   => api.delete(`/discussions/${id}/polls/${pid}`)
export const getDiscussionActivity = (id, scope = 'discussion') => api.get(`/discussions/${id}/activity`, { params: { scope } })
// The AI trip planner: a plan runs in the background - poll getTripPlan for its steps
export const listTripPlans  = (id)                     => api.get(`/discussions/${id}/trip-plans`)
export const createTripPlan = (id, prompt, parentId)   => api.post(`/discussions/${id}/trip-plans`, { prompt, parent_id: parentId || null })
export const getTripPlan    = (id, pid)                => api.get(`/discussions/${id}/trip-plans/${pid}`)
export const deleteTripPlan = (id, pid)                => api.delete(`/discussions/${id}/trip-plans/${pid}`)
export const addDiscussionPeople = (id, data)   => api.post(`/discussions/${id}/people`, data)
export const summariseDiscussion = (id)         => api.post(`/discussions/${id}/summary`)
export const setDiscussionNotify = (id, notify) => api.post(`/discussions/${id}/notify`, { notify })
export const editDiscussionMessage = (id, mid, text) => api.patch(`/discussions/${id}/messages/${mid}`, { text })
// A photo / PDF read by the AI into a chat summary - the file itself isn't kept
export const attachDiscussionFile = (id, file, caption = '') => {
  const fd = new FormData()
  fd.append('file', file)
  if (caption) fd.append('caption', caption)
  return api.post(`/discussions/${id}/attachments`, fd, { timeout: 180000 })
}
export const setQuoteOpinion = (id, qid, text, polished = false) => api.put(`/discussions/${id}/quotes/${qid}/opinion`, { text, polished })
export const reactInDiscussion = (id, target, targetId, kind) => api.post(`/discussions/${id}/reactions`, { target, target_id: targetId, kind })
