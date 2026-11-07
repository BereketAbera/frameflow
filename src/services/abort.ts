/** The error abortable work rejects with, shaped like Node's own AbortError and carrying the signal's reason as its cause. */
export function abortError(signal?: AbortSignal): Error {
  return Object.assign(new Error("The operation was aborted", { cause: signal?.reason }), { name: "AbortError", code: "ABORT_ERR" });
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}
