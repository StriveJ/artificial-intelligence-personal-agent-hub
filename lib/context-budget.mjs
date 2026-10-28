// UTF-8 projection bytes, independent of the model's token limit.
export const DEFAULT_HUB_CONTEXT_BUDGET = 1024 * 1024;
export function contextBudgetBytes(value = DEFAULT_HUB_CONTEXT_BUDGET) {
  if (!Number.isSafeInteger(value) || value < 1024 || value > 16 * 1024 * 1024) {
    throw new Error("contextBudgetBytes must be an integer from 1024 to 16777216 bytes");
  }
  return value;
}
