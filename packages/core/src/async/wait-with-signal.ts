/** 等待共享异步操作时只取消当前等待者；迟到结果仍被消费，不产生未处理拒绝。 */
export function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new DOMException('操作已取消', 'AbortError'))
    // 无论信号是否已取消，都接住原 Promise；不能为一个等待者取消其他调用者共享的操作。
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}
