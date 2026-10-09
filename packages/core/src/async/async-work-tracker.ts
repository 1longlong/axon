/** 登记实际异步工作；取消信号不等于 Promise 已结束，退出等待必须覆盖其 finally。 */
export class AsyncWorkTracker {
  private readonly pending = new Set<Promise<unknown>>()

  /** 先登记再调用，保持上游同步初始化顺序；成功/失败都移除，错误仍返回原调用者。 */
  run<T>(start: () => Promise<T>): Promise<T> {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (error: unknown) => void
    const work = new Promise<T>((done, failed) => { resolve = done; reject = failed })
    this.pending.add(work)
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work))
    try { resolve(start()) } catch (error) { reject(error) }
    return work
  }

  /** 入口先禁止新工作；循环等待现有链派生的附属工作，不以首批快照冒充全部结束。 */
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }
}
