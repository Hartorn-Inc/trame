# ============================================================================
# MONTHLY BUDGET: WARNINGS AND HARD CAP TRIGGER (budget.tf)
# ============================================================================
#
# PURPOSE:
# --------
# The near-free target needs a card on file; Europe egress, extra Cloud Run time
# or a forgotten resource can start costing money silently. One monthly budget
# on this project emails `var.budget_alert_email` at each warning amount
# (`var.budget_warning_amounts`, 1 and 5 EUR) and at the cap
# (`var.budget_amount`, 10 EUR), and publishes its status to the
# `budget-alerts` Pub/Sub topic, which triggers the hard cap
# (`budget_cap.tf`: billing is unlinked once spend reaches the cap).
#
# INVARIANTS & SAFETY BOUNDARIES:
# -------------------------------
#   1. `Actual Spend Only`:
#      - Every threshold uses current (actual) spend, never forecast spend, so
#        a forecast can neither email a false alarm nor stop the project.
#      - Thresholds are fractions of the cap: `warning / budget_amount`, plus
#        1.0 for the cap itself (0.1, 0.5 and 1.0 with the defaults).
#   2. `Billing Data Lags`:
#      - Costs reach the budget hours after the usage. Emails, Pub/Sub
#        messages and therefore the cap act on spend that is already late, so
#        the month can end slightly above `var.budget_amount`.
#   3. `Project-Scoped`:
#      - Only this project's costs count, after credits (the free tier is a
#        credit, so free usage does not count toward any threshold).
#   4. `Currency Must Match`:
#      - `var.budget_currency` must equal the billing account currency, or the
#        Billing Budgets API rejects the budget. A precondition reads the
#        account's currency at plan time and stops before that error.
#   5. `Pub/Sub Every Few Hours`:
#      - Besides threshold emails, a budget publishes its current cost to the
#        topic several times a day, whether or not a threshold was crossed.
#        The cap function decides from `costAmount` and `budgetAmount` in each
#        message, not from which threshold fired.
# ============================================================================

data "google_billing_account" "this" {
  billing_account = var.billing_account_id
  lookup_projects = false
}

resource "google_monitoring_notification_channel" "budget_email" {
  project      = var.project_id
  display_name = "TRAME budget alerts"
  type         = "email"
  labels = {
    email_address = var.budget_alert_email
  }

  depends_on = [google_project_service.enabled]
}

resource "google_pubsub_topic" "budget_alerts" {
  project = var.project_id
  name    = "budget-alerts"

  depends_on = [google_project_service.enabled]
}

# Cloud Billing publishes budget notifications as this Google-managed account.
# Linking a topic to a budget normally grants it; declaring the grant keeps it
# visible in Terraform and fails loudly if an organization policy refuses it.
resource "google_pubsub_topic_iam_member" "budget_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.budget_alerts.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:billing-budget-alert@system.gserviceaccount.com"
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

  dynamic "threshold_rules" {
    for_each = concat([for amount in var.budget_warning_amounts : amount / var.budget_amount], [1.0])
    content {
      threshold_percent = threshold_rules.value
      spend_basis       = "CURRENT_SPEND"
    }
  }

  all_updates_rule {
    monitoring_notification_channels = [google_monitoring_notification_channel.budget_email.id]
    pubsub_topic                     = google_pubsub_topic.budget_alerts.id
    schema_version                   = "1.0"
  }

  lifecycle {
    precondition {
      condition     = data.google_billing_account.this.currency_code == var.budget_currency
      error_message = "budget_currency must equal the billing account currency (${data.google_billing_account.this.currency_code}); amounts are in that currency."
    }
  }

  depends_on = [
    google_project_service.enabled,
    google_pubsub_topic_iam_member.budget_publisher,
  ]
}
