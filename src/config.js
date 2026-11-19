// All product limits live here, so new plans or rules need edits in one place.
// Add a plan (for example "plus") and teach planFor() who is on it.
export const PLANS = {
  free: {
    maxMessageChars: 8000,
    minMessageChars: 20,
    maxSubjectChars: 120,
    maxYearsAhead: 5,
    maxActiveLetters: 5, // pending + scheduled, per email address
  },
  // plus: { maxMessageChars: 30000, maxYearsAhead: 25, maxActiveLetters: 50 },
};

// Hook for later: look the address up in a payments table and return "plus".
export function planFor(env, email) {
  return 'free';
}

export const SETTINGS = {
  deliveryHourLocal: 9, // letters arrive around 9:00 in the writer's own time zone
  pendingExpiryHours: 48, // unconfirmed letters are erased after this
  maxPendingPerEmail: 3, // stops anyone using the form to spam an inbox
  maxAttempts: 5, // delivery retries before a letter is marked failed
  claimTimeoutMs: 60 * 60 * 1000, // a stuck "sending" letter is retried after this
  batchSize: 25, // letters handled per hourly run
  maxBodyBytes: 60000, // request size guard
  brand: 'Letters to the Future',
  family: 'a ThoughtsTalk project',
};
