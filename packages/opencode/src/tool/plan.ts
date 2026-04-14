import z from "zod"
import path from "path"
import { Effect } from "effect"
import { Tool } from "./tool"
import { Question } from "../question"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { Provider } from "../provider/provider"
import { Instance } from "../project/instance"
import { type SessionID, MessageID, PartID } from "../session/schema"
import EXIT_DESCRIPTION from "./plan-exit.txt"

type Meta = {
  switch: boolean
  decision: "build" | "continue"
  answers?: Question.Answer[]
}

const parameters = z.object({})

function getLastModel(sessionID: SessionID) {
  for (const item of MessageV2.stream(sessionID)) {
    if (item.info.role === "user" && item.info.model) return item.info.model
  }
  return undefined
}

export const PlanExitTool = Tool.define<typeof parameters, Meta>(
  "plan_exit",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service

    return {
      description: EXIT_DESCRIPTION,
      parameters,
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const info = yield* session.get(ctx.sessionID)
          const plan = path.relative(Instance.worktree, Session.plan(info))
          const pick = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: [
              {
                question: `Plan at ${plan} is complete. Would you like to switch to the build agent and start implementing?`,
                header: "Build Agent",
                custom: false,
                options: [
                  { label: "Yes", description: "Switch to build agent and start implementing the plan" },
                  { label: "No", description: "Stay with plan agent to continue refining the plan" },
                ],
              },
            ],
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          if (pick[0]?.[0] === "No") {
            const next = yield* question
              .ask({
                sessionID: ctx.sessionID,
                questions: [
                  {
                    question: "What should we refine next in the plan?",
                    header: "Continue Plan",
                    options: [],
                  },
                ],
                tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
              })
              .pipe(Effect.catchTag("QuestionRejectedError", () => Effect.succeed([[]])))

            return {
              title: "Continuing in plan agent",
              output: `User chose to keep planning. Follow-up input: ${next[0]?.join(", ") || "Unanswered"}. Use this feedback to refine the plan. If the plan is complete again later in this same turn, call plan_exit before ending the turn; otherwise continue planning or ask another clarifying question if needed.`,
              metadata: {
                switch: false,
                decision: "continue",
                answers: next,
              },
            }
          }

          const model = getLastModel(ctx.sessionID) ?? (yield* provider.defaultModel())

          const msg: MessageV2.User = {
            id: MessageID.ascending(),
            sessionID: ctx.sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model,
          }
          yield* session.updateMessage(msg)
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: ctx.sessionID,
            type: "text",
            text: `The plan at ${plan} has been approved, you can now edit files. Execute the plan`,
            synthetic: true,
          } satisfies MessageV2.TextPart)

          return {
            title: "Switching to build agent",
            output: "User approved switching to build agent. Wait for further instructions.",
            metadata: { switch: true, decision: "build" },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
