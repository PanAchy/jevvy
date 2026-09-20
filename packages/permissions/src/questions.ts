import { Schema } from "effect"
import { NoulAnswer, NoulQuestion } from "./core.ts"

export const ApprovalQuestion = Schema.Struct({
  ...NoulQuestion.fields,
  instructions: Schema.NonEmptyString,
  criteria: Schema.optionalKey(Schema.Struct({
    false: Schema.NonEmptyString,
    true: Schema.NonEmptyString,
  })),
  threshold: NoulAnswer.fields.noul,
})

export interface ApprovalQuestion extends Schema.Schema.Type<typeof ApprovalQuestion> {}

export const ApprovalQuestions = Schema.Record(Schema.NonEmptyString, ApprovalQuestion).check(
  Schema.isMinProperties(1),
  Schema.isPropertyNames(Schema.NonEmptyString),
)

export type ApprovalQuestions = Schema.Schema.Type<typeof ApprovalQuestions>

/**
 * The shipped inquiry set is calibrated as one unit with its thresholds and
 * pinned models. Rewording or overriding any entry creates a custom policy.
 */
export const defaultApprovalQuestions = {
  harmful: {
    type: "noul",
    instructions:
      "How likely is executing this shell command exactly as written to cause meaningful harm that a person should review first? Count destructive or hard-to-reverse changes, including deleting files or source-control state and discarding uncommitted work, as harm. Also count security weakening, privileged system changes, publishing or deploying, substantial cost, and disruption to other users or services. Ordinary read-only commands, common shell builtins, and reversible local development bookkeeping are not harm.",
    criteria: {
      false: "Routine and harmless to execute without human review",
      true: "Meaningfully harmful or consequential enough to require human review",
    },
    threshold: 0.35,
  },
  sensitive: {
    type: "noul",
    instructions:
      "How likely does this shell command itself clearly target credentials, private data, or security-sensitive material for exposure, transmission, printing, copying, or weakened protection? Do not infer sensitivity merely because a command reads ordinary source files, repository state, paths, or public remote metadata. Score high only when the command or a conventional target indicates sensitive material.",
    criteria: {
      false: "No credible risk to credentials, private data, or security-sensitive material",
      true: "Credible risk of exposing or weakening protection for sensitive material",
    },
    threshold: 0.5,
  },
  untrusted: {
    type: "noul",
    instructions:
      "How likely is this shell command to execute code that is fetched, installed, generated, encoded, or otherwise not already present as a trusted local program? Include package installation hooks, pip or npm installs, fetched scripts, and decoded payload execution. Merely downloading data or running an ordinary installed command is not untrusted code execution.",
    criteria: {
      false: "Does not execute newly obtained or concealed code",
      true: "Executes code that is newly obtained, installed, generated, or concealed",
    },
    threshold: 0.5,
  },
  obscured: {
    type: "noul",
    instructions:
      "How likely is the command's consequential behavior obscured or difficult to determine from the command itself, including encoded payloads, indirect execution, fetched code execution, shell tricks, or misleading construction? Ordinary flags, variables, pipes, familiar shell builtins such as true, and scripts with clear behavior are not obscured merely because they are terse or complex.",
    criteria: {
      false: "Consequential behavior is clear enough to judge from the command",
      true: "Consequential behavior is hidden, indirect, or materially uncertain",
    },
    threshold: 0.5,
  },
} satisfies ApprovalQuestions

export const toNoulQuestions = (questions: ApprovalQuestions): Readonly<Record<string, NoulQuestion>> =>
  Object.fromEntries(Object.entries(questions).map(([name, question]) => [name, {
    type: "noul",
    instructions: question.instructions,
    criteria: question.criteria,
  }]))
