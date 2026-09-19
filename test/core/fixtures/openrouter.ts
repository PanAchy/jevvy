// Synthetic chat-completion fixtures, not captures from a live provider.
export const riskScores = { destructive: 0.1, sensitive: 0, executes: 0.8, network: 1, obfuscated: 0 }

export const contextScores = { ...riskScores, authorized: 0.95, off_task: 0.05 }

export const completion = (content: string, finishReason = "stop") => ({
  id: "gen-fixture",
  model: "provider/test-model",
  choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content } }],
  usage: { prompt_tokens: 300, completion_tokens: 45, total_tokens: 345 },
})

export const riskCompletion = completion(JSON.stringify(riskScores))

export const contextCompletion = completion(JSON.stringify(contextScores))
