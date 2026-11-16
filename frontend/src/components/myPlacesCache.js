import { getMyPlaces } from '../api'

/** "Places I've eaten at": the last list is kept on this device and shown at
 *  once; the server's answer (it waits behind the page's other requests)
 *  replaces it. */
const PLACES_KEY = 'food.myPlaces'

export function cachedPlaces() {
  try { return JSON.parse(localStorage.getItem(PLACES_KEY) || 'null') } catch { return null }
}

export function loadMyPlaces() {
  return getMyPlaces().then((r) => {
    try { localStorage.setItem(PLACES_KEY, JSON.stringify(r.data)) } catch { /* private mode */ }
    return r.data
  })
}
