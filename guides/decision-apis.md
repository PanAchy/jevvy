# OpenAI and Microsoft decision APIs

Jevvy Permissions offers built-in setup choices for OpenAI Decisions and Microsoft Decision in Azure Foundry. Run `npx @jevvy/permissions init` and type a provider name to filter the choices, or edit your global `~/.config/jevvy/jevvy.jsonc` using the examples below.

These integrations do not change the approval policy. Jevvy's shipped questions and thresholds are calibrated for Jev, not `gpt-6-luna` or Microsoft-Decision-1. Configure and calibrate `permissions.questions` for your selected model before relying on auto-approval. Without that setting, Jevvy uses the unchanged Jev defaults. The optional [calibrate-permissions skill](../skills/calibrate-permissions/SKILL.md) can help validate a candidate against the bundled baseline.

## OpenAI Decisions

You need an OpenAI API key and access to the [Decisions API](https://developers.openai.com/api/docs/guides/decisions). The API is in public beta and currently supports `gpt-6-luna`.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/PanAchy/jevvy/main/config.schema.json",
  "provider": "openai",
  "providers": {
    "openai": { "apiKey": "your-openai-api-key" },
  },
}
```

Alternatively, omit `providers.openai` and set `OPENAI_API_KEY` in the agent process's environment. A key in the global file takes precedence.

Jevvy posts to `https://api.openai.com/v1/decisions`. It serializes structured command evidence to JSON text, translates keyed Noul questions into named predicates, and includes any false/true criteria in the predicate instructions. Predicate probabilities map back to Noul probabilities without inversion. These changes in question presentation are another reason to calibrate with the actual adapter.

Each requested question must receive its named predicate answer in the documented question order. Refusals, missing or duplicate names, invalid probabilities, malformed responses, timeouts, and provider failures leave the host's remaining permission flow unchanged. Jevvy does not use the Responses or Chat Completions APIs as a fallback.

## Microsoft Decision in Azure Foundry

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
- `model` is your deployment name, not necessarily the catalog ID `Microsoft-Decision-1`. The response's underlying model ID may differ and is retained in judgment results.
- `apiKey` is sent in Azure's `api-key` header, not Bearer auth. Alternatively, omit this field and set `AZURE_AI_API_KEY` in the agent process's environment. A file key takes precedence.

This preset supports Azure API keys only. It does not acquire or refresh Microsoft Entra tokens; do not put an Entra token in `apiKey`.

The adapter sends the complete command evidence and keyed Noul questions through the System One transport. Every requested question must receive a valid standard `{ "type": "noul", "noul": probability }` answer. Missing or incompatible answers and provider failures leave the host's remaining permission flow unchanged.

## API compatibility versus calibration

Setup presets handle routes and wire formats. They do not certify a model's permission decisions. Switching providers or models does not recalibrate the policy, and Jevvy never falls back to another provider automatically.

For either integration, `permissions.questions` replaces all shipped questions. A candidate must pass Jevvy's bundled harmless and must-ask cases plus any additional cases for your workflow. See the README's [approval policy](../README.md#approval-policy) and [calibration instructions](../README.md#calibrate-custom-questions).
