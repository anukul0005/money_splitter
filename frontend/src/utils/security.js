// Shared security-question options, used by the account page, signup, the
// reset page and the admin screens so the list can't drift between them.

/** Ordinary questions — the normal way to set up recovery: pick one, type an answer. */
export const RECOVERY_QUESTIONS = [
  'What was the name of your first school?',
  'What city were you born in?',
  "What is your oldest sibling's nickname?",
  'What was the name of your first pet?',
  'What is your favourite dish?',
  'What is your mother’s maiden name?',
]

/** Alternative for people who would rather memorise/store a random code than answer a question. */
export const KEY_QUESTION = 'Enter your 6-digit recovery key'

/** Everything selectable, with the passkey option last so it is opt-in. */
export const ALL_QUESTIONS = [...RECOVERY_QUESTIONS, KEY_QUESTION]

/** Cryptographically random 6-digit key. */
export function generateKey() {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return String(buf[0] % 1000000).padStart(6, '0')
}
