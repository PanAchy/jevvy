# Microsoft Decision in Azure Foundry

Select Microsoft Decision in `npx @jevvy/permissions init`, or configure Jevvy Permissions in your global `~/.config/jevvy/jevvy.jsonc` as shown below.

You need an Azure Foundry resource, a deployed Microsoft-Decision-1 model, and an Azure AI API key. Follow Microsoft's [deployment guide](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision) for resource access, regional availability, and quotas.

This integration is experimental. Its request and API-key authentication follow Microsoft's Foundry documentation. It expects standard System One Noul responses; the Foundry guide does not publish a complete Noul response example, and this integration has not been verified against a live Foundry deployment. An incompatible response results in abstention, never a guessed probability.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/PanAchy/jevvy/main/config.schema.json",
  "provider": "microsoft",
  "providers": {
    "microsoft": {
      "endpoint": "https://YOUR-RESOURCE.services.ai.azure.com/providers/microsoft/v1/systemone",
      "model": "your-deployment-name",
      "apiKey": "your-azure-ai-api-key",
    },
  },
}
```

- `endpoint` is the full HTTPS inference URL, including `/providers/microsoft/v1/systemone`. Jevvy uses this URL as supplied; it does not append a path.
- `model` is your deployment name, not the catalog ID. Calibration expects the provider-pinned response identity `microsoft-decision-1`; it records the deployment name and the actual reported identity separately. A different reported identity fails calibration. No additional model setting is needed.
- `apiKey` is sent in Azure's `api-key` header, not Bearer auth. Alternatively, omit this field and set `AZURE_AI_API_KEY` in the agent process's environment. A file key takes precedence.

This preset supports Azure API keys only. It does not acquire or refresh Microsoft Entra tokens; do not put an Entra token in `apiKey`.

The adapter sends the complete command evidence and keyed Noul questions through the System One transport. Every requested question must receive a valid standard `{ "type": "noul", "noul": probability }` answer. Missing or incompatible answers and provider failures leave the host's remaining permission flow unchanged.

## Calibration

Jevvy's default questions and thresholds are calibrated for Jev, not Microsoft-Decision-1. Configure and calibrate `permissions.questions` before relying on auto-approval. Without that setting, Jevvy uses the unchanged Jev defaults. See the README's [approval policy](../README.md#approval-policy) and [calibration instructions](../README.md#calibrate-custom-questions).
