# ============================================================================
# BUDGET ALERT (budget.tf)
# ============================================================================
#
# PURPOSE:
# --------
# The near-free target needs a card on file; Europe egress, extra Cloud Run time
# or a forgotten resource can start costing money silently. A monthly budget of
# `var.budget_amount` (1 EUR) on this project emails `var.budget_alert_email`.
#
# INVARIANTS & SAFETY BOUNDARIES:
# -------------------------------
#   1. `Alert, Not Cap`:
#      - Budgets never stop spending. They notify at 50 % and 100 % of actual
#        spend and at 100 % of forecast spend, hours after the usage (billing
#        data lags). Disable the service (`--scaling=0`) to stop costs.
#   2. `Project-Scoped`:
#      - Only this project's costs count, after credits (the free tier is a
#        credit, so free usage does not trigger alerts).
#   3. `Currency Must Match`:
#      - `var.budget_currency` must equal the billing account currency, or the
#        Billing Budgets API rejects the budget.
# ============================================================================

resource "google_monitoring_notification_channel" "budget_email" {
  project      = var.project_id
  display_name = "TRAME budget alerts"
  type         = "email"
  labels = {
    email_address = var.budget_alert_email
  }

  depends_on = [google_project_service.enabled]
}

resource "google_billing_budget" "trame" {
  billing_account = var.billing_account_id
  display_name    = "TRAME ${var.project_id}"

  budget_filter {
    projects               = ["projects/${data.google_project.this.number}"]
    calendar_period        = "MONTH"
    credit_types_treatment = "INCLUDE_ALL_CREDITS"
  }

  amount {
    specified_amount {
      currency_code = var.budget_currency
      units         = tostring(var.budget_amount)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }

  threshold_rules {
    threshold_percent = 1.0
  }

  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }

  all_updates_rule {
    monitoring_notification_channels = [google_monitoring_notification_channel.budget_email.id]
  }

  depends_on = [google_project_service.enabled]
}
