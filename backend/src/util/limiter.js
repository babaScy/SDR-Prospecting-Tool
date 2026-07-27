// Minimal in-process counting semaphore. Single-process only.
function makeLimiter(max) {
  let active = 0;
  const queue = [];

  const pump = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => { active--; pump(); });
  };

  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
  };
}

module.exports = { makeLimiter };
