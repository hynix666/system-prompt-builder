export const MAX_LOCAL_RELOAD_RETRIES = 3;

export function localRetryBackoffSeconds(attempt: number) {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_LOCAL_RELOAD_RETRIES) return null;
  return 2 ** (attempt - 1);
}
