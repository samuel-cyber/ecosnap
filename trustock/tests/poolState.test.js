// The lifecycle is a contract. These tests pin the moves that must never work.

const test = require('node:test');
const assert = require('node:assert/strict');
const { STATES, canTransition, nextStates } = require('../src/lib/poolState');

test('the happy path is walkable end to end', () => {
  const path = ['CREATED', 'FUNDING', 'MOQ_REACHED', 'RISK_REVIEW', 'APPROVED', 'SETTLEMENT', 'COMPLETED'];
  for (let i = 0; i < path.length - 1; i += 1) {
    assert.ok(canTransition(path[i], path[i + 1]), `${path[i]} -> ${path[i + 1]} should be allowed`);
  }
});

test('the risk review cannot be skipped', () => {
  assert.equal(canTransition('MOQ_REACHED', 'APPROVED'), false);
  assert.equal(canTransition('MOQ_REACHED', 'SETTLEMENT'), false);
  assert.equal(canTransition('FUNDING', 'SETTLEMENT'), false);
  assert.equal(canTransition('FUNDING', 'COMPLETED'), false);
});

test('a rejected pool leads to refunds, never to settlement', () => {
  assert.ok(canTransition('REJECTED', 'REFUNDING'));
  assert.equal(canTransition('REJECTED', 'SETTLEMENT'), false);
  assert.equal(canTransition('REJECTED', 'APPROVED'), false);
});

test('a failed settlement returns to APPROVED so it can be retried', () => {
  assert.ok(canTransition('SETTLEMENT', 'APPROVED'));
});

test('terminal states are terminal', () => {
  assert.deepEqual(nextStates(STATES.COMPLETED), []);
  assert.deepEqual(nextStates(STATES.REFUNDED), []);
  assert.equal(canTransition('COMPLETED', 'SETTLEMENT'), false);
  assert.equal(canTransition('REFUNDED', 'FUNDING'), false);
});

test('an expired pool can only be refunded', () => {
  assert.deepEqual(nextStates(STATES.EXPIRED), ['REFUNDING']);
});
