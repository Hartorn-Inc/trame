/**
 * ============================================================================
 * BUDGET HARD CAP DECISION (cap.js)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Google Cloud budgets only notify; they never stop spending. The project's
 * monthly budget (`budget.tf`) publishes its status to the `budget-alerts`
 * Pub/Sub topic several times a day. This module reads each notification and, once actual
 * spend reaches the budget amount, unlinks the project from its billing
 * account. Without it, a runaway resource or an egress spike keeps billing the
 * card until someone reads the alert emails.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Stop At The Cap, Not Above It`:
 *      - Billing is unlinked when `costAmount >= budgetAmount`. Google's sample
 *        (and the pattern this was ported from) uses `<=` to mean "no action",
 *        which only stops strictly above the cap.
 *   2. `Malformed Messages Never Unlink`:
 *      - A message that is not base64 JSON with numeric `costAmount` and
 *        `budgetAmount` is logged and ignored. Unlinking stops the whole
 *        project, so only a well-formed notification may trigger it.
 *   3. `Fail Toward The Cap`:
 *      - If the current billing status cannot be read, billing is assumed to be
 *        enabled and the unlink is attempted anyway.
 *      - A failed unlink throws, so the invocation is logged as an error. The
 *        trigger does not retry; the next notification (hours later at most)
 *        tries again.
 *   4. `Idempotent`:
 *      - A project already without billing is left untouched.
 *
 * EXECUTION LIFECYCLE:
 * --------------------
 *   `handleBudgetNotification(cloudEvent, { billing, projectName, log })`
 *   ├── 1. Decode `data.message.data` (base64 JSON) and validate the amounts.
 *   ├── 2. `costAmount < budgetAmount` -> `below-cap`, nothing else.
 *   ├── 3. `getProjectBillingInfo` -> already disabled -> `already-disabled`.
 *   └── 4. `updateProjectBillingInfo` with an empty billing account -> `billing-disabled`.
 * ============================================================================
 */

'use strict';

/** Result of one notification, logged by the handler and asserted by the tests. */
const Outcome = Object.freeze({
  /** The message is not a budget notification with numeric amounts; nothing was done. */
  MALFORMED: 'malformed',
  /** Actual spend is below the budget amount; nothing was done. */
  BELOW_CAP: 'below-cap',
  /** The cap is reached but the project already has no billing account. */
  ALREADY_DISABLED: 'already-disabled',
  /** The cap is reached and the project was unlinked from its billing account. */
  BILLING_DISABLED: 'billing-disabled',
});

/**
 * Decodes the budget notification carried by a Pub/Sub CloudEvent.
 *
 * Returns `null` instead of throwing for any message that is not base64 JSON
 * with finite numeric `costAmount` and `budgetAmount` (both in the budget's
 * currency), so a malformed message can never reach the unlink call.
 */
function parseBudgetNotification(cloudEvent) {
  const encoded = cloudEvent?.data?.message?.data;
  if (typeof encoded !== 'string') {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  const { costAmount, budgetAmount, currencyCode } = payload ?? {};
  if (!Number.isFinite(costAmount) || !Number.isFinite(budgetAmount)) {
    return null;
  }
  return { costAmount, budgetAmount, currencyCode };
}

/** True once actual spend has reached the budget amount (the cap is inclusive). */
function isCapReached({ costAmount, budgetAmount }) {
  return costAmount >= budgetAmount;
}

async function isBillingEnabled(billing, projectName, log) {
  try {
    const [info] = await billing.getProjectBillingInfo({ name: projectName });
    return info.billingEnabled;
  } catch (error) {
    log.error(`Cannot read the billing status of ${projectName}, assuming it is enabled: ${error.message}`);
    return true;
  }
}

/**
 * Applies the hard cap for one budget notification and returns its `Outcome`.
 *
 * `billing` is a `CloudBillingClient` (or a test double with the same two
 * methods), `projectName` is `projects/<project id>`, and `log` exposes
 * `info`, `warn` and `error` (the console in production).
 */
async function handleBudgetNotification(cloudEvent, { billing, projectName, log }) {
  const notification = parseBudgetNotification(cloudEvent);
  if (notification === null) {
    log.error('Ignoring a message that is not a budget notification with numeric costAmount and budgetAmount.');
    return Outcome.MALFORMED;
  }

  const { costAmount, budgetAmount, currencyCode } = notification;
  log.info(`Spend ${costAmount} of ${budgetAmount} ${currencyCode ?? ''}`.trimEnd());
  if (!isCapReached(notification)) {
    return Outcome.BELOW_CAP;
  }

  if (!(await isBillingEnabled(billing, projectName, log))) {
    log.info(`Cap reached; billing is already disabled on ${projectName}.`);
    return Outcome.ALREADY_DISABLED;
  }

  await billing.updateProjectBillingInfo({
    name: projectName,
    projectBillingInfo: { billingAccountName: '' },
  });
  log.warn(`Cap reached (${costAmount} >= ${budgetAmount}): unlinked ${projectName} from its billing account.`);
  return Outcome.BILLING_DISABLED;
}

module.exports = { Outcome, parseBudgetNotification, isCapReached, handleBudgetNotification };
