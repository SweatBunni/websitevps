/**
 * runtime-utils.mjs — VPS-safe async utilities.
 * The old version wrapped Vercel's waitUntil(); on a VPS we just run the task
 * as an unattached promise so the HTTP response can return immediately while
 * background work (e.g. a Gradle build) keeps running.
 */

/**
 * Fire-and-forget a background promise.
 * The response is already sent by the time this runs; we just need Node to
 * stay alive while it executes (it will, as long as the server is listening).
 *
 * @param {Promise<unknown>} task
 */
export function scheduleBackgroundTask(task) {
  Promise.resolve(task).catch(err => {
    console.error('[codexmc] background task failed:', err);
  });
}

/**
 * Pause for `ms` milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
