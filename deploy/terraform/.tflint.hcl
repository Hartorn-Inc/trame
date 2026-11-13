# TFLint configuration for deploy/terraform (`make lint-terraform`).
# Plugins are pinned; `tflint --init` downloads and verifies them.

config {
  call_module_type = "none"
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "google" {
  enabled = true
  version = "0.41.0"
  source  = "github.com/terraform-linters/tflint-ruleset-google"
}

rule "terraform_documented_variables" {
  enabled = true
}

rule "terraform_documented_outputs" {
  enabled = true
}
