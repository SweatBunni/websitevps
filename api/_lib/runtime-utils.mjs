import { waitUntil } from '@vercel/functions';

export function scheduleBackgroundTask(taskPromise) {
  if (process.env.VERCEL) {
    waitUntil(taskPromise);
    return;
  }

  taskPromise.catch(error => {
    console.error('[codexmc] background task failed:', error);
  });
}
