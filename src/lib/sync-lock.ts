// Pull (Jira → local) and push (local → Jira) both read-modify-write the same tasks and
// worklogs in IndexedDB. Running them at the same time can resurrect a task as "dirty" right
// after it was pushed, or show a worklog twice, so every sync operation takes this lock.
let tail: Promise<unknown> = Promise.resolve();
let held = 0;

/** True while an operation is running or queued — a new caller would have to wait. */
export function isSyncLockHeld(): boolean {
  return held > 0;
}

export function runExclusiveSync<T>(operation: () => Promise<T>): Promise<T> {
  held += 1;
  const run = tail.then(operation, operation);
  tail = run
    .catch(() => undefined)
    .finally(() => {
      held -= 1;
    });
  return run;
}
