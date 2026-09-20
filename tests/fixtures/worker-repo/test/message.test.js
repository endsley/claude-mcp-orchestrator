import assert from 'node:assert/strict';
import test from 'node:test';
import { message } from '../src/message.js';

test('fixture starts with a controlled expected message', () => {
  assert.equal(message, 'hello from fixture');
});
