# OpenAI Decisions

Select OpenAI Decisions in `npx @jevvy/permissions init`, or configure Jevvy Permissions in your global `~/.config/jevvy/jevvy.jsonc` as shown below.

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

## Calibration

Jevvy's default questions and thresholds are calibrated for Jev, not `gpt-6-luna`. Configure and calibrate `permissions.questions` before relying on auto-approval. Without that setting, Jevvy uses the unchanged Jev defaults. See the README's [approval policy](../README.md#approval-policy) and [calibration instructions](../README.md#calibrate-custom-questions).
