const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeLimiter } = require('../src/util/limiter');

const defer = (ms) => new Promise((r) => setTimeout(r, ms));

test('never exceeds max concurrency', async () => {
  const run = makeLimiter(2);
  let active = 0, peak = 0;
  const task = () => run(async () => {
    active++; peak = Math.max(peak, active);
    await defer(10);
    active--;
  });
  await Promise.all(Array.from({ length: 8 }, task));
  assert.ok(peak <= 2, `peak was ${peak}`);
});

test('returns fn result and frees slot on rejection', async () => {
  const run = makeLimiter(1);
  assert.equal(await run(async () => 42), 42);
  await assert.rejects(run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await run(async () => 'after'), 'after'); // slot was freed
});
