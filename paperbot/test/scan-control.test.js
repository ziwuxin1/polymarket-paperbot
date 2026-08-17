import test from 'node:test';
import assert from 'node:assert/strict';
import { hasReachedTarget } from '../src/scan-control.js';

test('no target means the loop is never told to stop', () => {
  assert.equal(hasReachedTarget({ recordedDecisions: 10_000, targetDecisions: 0 }), false);
});

test('the loop stops once the target is reached or passed', () => {
  assert.equal(hasReachedTarget({ recordedDecisions: 4_999, targetDecisions: 5_000 }), false);
  assert.equal(hasReachedTarget({ recordedDecisions: 5_000, targetDecisions: 5_000 }), true);
  assert.equal(hasReachedTarget({ recordedDecisions: 5_050, targetDecisions: 5_000 }), true);
});
