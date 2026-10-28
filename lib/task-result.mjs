export const TASK_STATUSES = Object.freeze(['success', 'partial', 'deferred', 'blocked', 'error', 'unknown']);
export function taskResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !TASK_STATUSES.includes(result.status)) {
    return { status: 'error', code: 'invalid_task_result', summary: "Task result violates the contract. Check the implementation." };
  }
  return result;
}
