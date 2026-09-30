/**
 * Minimal bounded-concurrency limiter for sub-agent runtime isolation.
 *
 * Caps the number of simultaneously-running extraction tasks so an entry
 * flood cannot exhaust the event loop or LLM provider rate limits. Excess
 * work queues (FIFO) and runs as slots free; nothing is dropped. The slot
 * is released on BOTH success and failure (via finally) so a throwing task
 * cannot leak a slot.
 */
export function createLimiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    active--;
    const fn = queue.shift();
    if (fn) fn();
  };

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const start = () => {
          active++;
          task().then(resolve, reject).finally(next);
        };
        if (active < max) start();
        else queue.push(start);
      });
    },
  };
}
