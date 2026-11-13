'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { Outcome, handleBudgetNotification } = require('../cap');

const PROJECT_NAME = 'projects/my-trame-project';
const silentLog = { info() {}, warn() {}, error() {} };

/** Wraps a JSON payload the way Eventarc delivers a Pub/Sub message. */
function pubsubEvent(payload) {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { data: { message: { data: Buffer.from(raw, 'utf8').toString('base64') } } };
}

function budgetEvent(costAmount, budgetAmount) {
  return pubsubEvent({
    budgetDisplayName: 'TRAME my-trame-project',
    costAmount,
    budgetAmount,
    currencyCode: 'EUR',
    costIntervalStart: '2026-11-01T00:00:00Z',
    budgetAmountType: 'SPECIFIED_AMOUNT',
  });
}

/** Records the calls a `CloudBillingClient` would receive. */
function fakeBilling({ billingEnabled = true, readError = null } = {}) {
  const calls = { get: [], update: [] };
  return {
    calls,
    async getProjectBillingInfo(request) {
      calls.get.push(request);
      if (readError) {
        throw readError;
      }
      return [{ name: `${request.name}/billingInfo`, billingEnabled }];
    },
    async updateProjectBillingInfo(request) {
      calls.update.push(request);
      return [{ name: `${request.name}/billingInfo`, billingEnabled: false }];
    },
  };
}

const UNLINK_REQUEST = { name: PROJECT_NAME, projectBillingInfo: { billingAccountName: '' } };

const cases = [
  {
    id: 'below cap: 9.99 of 10 EUR keeps billing and does not read its status',
    event: budgetEvent(9.99, 10),
    billing: {},
    expected: Outcome.BELOW_CAP,
    reads: 0,
    unlinked: false,
  },
  {
    id: 'warning threshold: 5 of 10 EUR only notifies',
    event: budgetEvent(5, 10),
    billing: {},
    expected: Outcome.BELOW_CAP,
    reads: 0,
    unlinked: false,
  },
  {
    id: 'at cap: 10 of 10 EUR unlinks billing',
    event: budgetEvent(10, 10),
    billing: {},
    expected: Outcome.BILLING_DISABLED,
    reads: 1,
    unlinked: true,
  },
  {
    id: 'above cap: 12.5 of 10 EUR unlinks billing',
    event: budgetEvent(12.5, 10),
    billing: {},
    expected: Outcome.BILLING_DISABLED,
    reads: 1,
    unlinked: true,
  },
  {
    id: 'billing already disabled: 15 of 10 EUR makes no update',
    event: budgetEvent(15, 10),
    billing: { billingEnabled: false },
    expected: Outcome.ALREADY_DISABLED,
    reads: 1,
    unlinked: false,
  },
  {
    id: 'billing status unreadable: assumes enabled and unlinks',
    event: budgetEvent(11, 10),
    billing: { readError: new Error('PERMISSION_DENIED') },
    expected: Outcome.BILLING_DISABLED,
    reads: 1,
    unlinked: true,
  },
  {
    id: 'malformed: payload is not JSON',
    event: pubsubEvent('not json'),
    billing: {},
    expected: Outcome.MALFORMED,
    reads: 0,
    unlinked: false,
  },
  {
    id: 'malformed: costAmount is a string',
    event: pubsubEvent({ costAmount: '12', budgetAmount: 10 }),
    billing: {},
    expected: Outcome.MALFORMED,
    reads: 0,
    unlinked: false,
  },
  {
    id: 'malformed: budgetAmount is missing',
    event: pubsubEvent({ costAmount: 12 }),
    billing: {},
    expected: Outcome.MALFORMED,
    reads: 0,
    unlinked: false,
  },
  {
    id: 'malformed: JSON null payload',
    event: pubsubEvent('null'),
    billing: {},
    expected: Outcome.MALFORMED,
    reads: 0,
    unlinked: false,
  },
  {
    id: 'malformed: event without message data',
    event: { data: {} },
    billing: {},
    expected: Outcome.MALFORMED,
    reads: 0,
    unlinked: false,
  },
];

for (const { id, event, billing: billingOptions, expected, reads, unlinked } of cases) {
  test(id, async () => {
    const billing = fakeBilling(billingOptions);

    const outcome = await handleBudgetNotification(event, { billing, projectName: PROJECT_NAME, log: silentLog });

    assert.equal(outcome, expected);
    assert.equal(billing.calls.get.length, reads);
    assert.deepEqual(billing.calls.update, unlinked ? [UNLINK_REQUEST] : []);
  });
}

test('failed unlink: the error propagates so the invocation is logged as failed', async () => {
  const billing = fakeBilling();
  billing.updateProjectBillingInfo = async () => {
    throw new Error('PERMISSION_DENIED');
  };

  await assert.rejects(
    handleBudgetNotification(budgetEvent(10, 10), { billing, projectName: PROJECT_NAME, log: silentLog }),
    /PERMISSION_DENIED/,
  );
});
