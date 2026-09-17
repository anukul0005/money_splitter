import { getVapidPublicKey, subscribePush, unsubscribePush } from './api'

// The browser's PushManager wants the VAPID public key as raw bytes, not
// the base64url string the backend hands out - this is the one conversion
// step the Push API itself requires.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window
}

// Whether this browser already holds a subscription - used to render the
// Account settings toggle in the right state on load, without asking for
// permission again just to check.
export async function getExistingSubscription() {
  if (!pushSupported()) return null
  const reg = await navigator.serviceWorker.getRegistration('/sw.js')
  if (!reg) return null
  return reg.pushManager.getSubscription()
}

// Registers the service worker (idempotent - re-registering the same URL
// is a no-op if it's unchanged), asks for notification permission, and
// sends the resulting subscription to the backend. Throws if the user
// declines permission or push isn't supported - callers show that as an
// error rather than a silent no-op, since this is always the result of an
// explicit "Enable notifications" tap.
export async function enablePush() {
  if (!pushSupported()) throw new Error('Push notifications are not supported in this browser.')

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notification permission was not granted.')

  const reg = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready

  const { data } = await getVapidPublicKey()
  if (!data.key) throw new Error('Push is not configured on the server yet.')

  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(data.key),
  })

  const json = subscription.toJSON()
  await subscribePush({ endpoint: json.endpoint, keys: json.keys })
  return subscription
}

export async function disablePush() {
  const sub = await getExistingSubscription()
  if (!sub) return
  try {
    await unsubscribePush({ endpoint: sub.endpoint })
  } finally {
    await sub.unsubscribe()
  }
}
