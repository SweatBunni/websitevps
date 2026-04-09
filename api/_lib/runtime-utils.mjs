import { waitUntil } from '@vercel/functions';

export function scheduleBackgroundTask(taskPromise) {
  const safeTask = Promise.resolve(taskPromise).catch(error => {
    console.error('[codexmc] background task failed:', error);
  });

  if (process.env.VERCEL) {
    waitUntil(safeTask);
    return;
  }
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
