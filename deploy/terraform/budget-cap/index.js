/**
 * ============================================================================
 * BUDGET HARD CAP ENTRY POINT (index.js)
 * ============================================================================
 *
 * PURPOSE:
 * --------
 * Registers `stopBilling`, the CloudEvent handler of the `trame-budget-cap`
 * Cloud Run function (`budget_cap.tf`), triggered by every message on the
 * `budget-alerts` topic. The decision logic lives in `cap.js` so it can be
 * tested without Google credentials.
 *
 * INVARIANTS & SAFETY BOUNDARIES:
 * -------------------------------
 *   1. `Explicit Target Project`:
 *      - `TARGET_PROJECT_ID` is set by Terraform; the runtime does not rely on
 *        `GOOGLE_CLOUD_PROJECT`, which Cloud Run functions do not always set.
 *   2. `Least Privilege`:
 *      - The function's service account holds `roles/billing.projectManager`
 *        on this project only; it cannot touch the billing account or any
 *        other project.
 * ============================================================================
 */

'use strict';

const functions = require('@google-cloud/functions-framework');
const { CloudBillingClient } = require('@google-cloud/billing');
const { handleBudgetNotification } = require('./cap');

const projectName = `projects/${process.env.TARGET_PROJECT_ID}`;
const billing = new CloudBillingClient();

functions.cloudEvent('stopBilling', (cloudEvent) =>
  handleBudgetNotification(cloudEvent, { billing, projectName, log: console }),
);
