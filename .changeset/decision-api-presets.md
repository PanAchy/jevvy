---
"@jevvy/permissions": minor
---

## New providers

Add built-in setup choices for OpenAI Decisions with `gpt-6-luna` and experimental Microsoft-Decision-1 integration through Azure Foundry. OpenAI predicates map to Jevvy's probability answers; Microsoft uses the configured deployment and Azure API-key authentication.

The existing questions and thresholds remain unchanged and calibrated for Jev. Other models require user calibration; API compatibility does not transfer Jev's calibration evidence.

## Configuration

Type a provider name to filter assisted setup choices. Group setup documentation by API format, with per-service credentials and examples for both new integrations.
