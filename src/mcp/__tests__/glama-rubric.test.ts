/**
 * Phase 10.5 QUAL-14 mechanizable lint (D-10.5-15).
 *
 * Iterates registeredTools and asserts the 4 mechanizable Glama TDQS rules
 * per tool. Editorial dimensions (Purpose Clarity 25%, Usage Guidelines 20%,
 * Behavioral Transparency 20%, Contextual Completeness 10%) are scored by
 * hand in the phase directory `10.5-GLAMA-SELF-SCORE.md` (Wave 5).
 *
 * Rule mapping:
 *   Rule 1 -> Conciseness 10% (description.length <= 300)
 *   Rule 2 -> em-dash discipline (feedback_no_em_dashes; 0 matches)
 *   Rule 3 -> Structure (first sentence verb-then-object)
 *   Rule 4 -> Usage Guidelines 20% (second sentence "Use this when...")
 *   Rule 5 -> Parameter Semantics 15% (every inputSchema param has .describe())
 *
 * Per the RESEARCH.md interleaving note: Wave 5 will edit tool descriptions
 * to turn any red rules green. The lint test ships RED-able in Wave 4 and
 * GREEN after Wave 5.
 *
 * Introspection note: tool.inputSchema is the SDK-wrapped ZodObject (NOT the
 * raw shape map). Walk via tool.inputSchema.shape, which exposes the
 * Record<string, ZodTypeAny> map for both Zod 3 and Zod 4 wrappers per
 * confirmed via the diagnostic harness at plan-execution time.
 */
import { describe, it, expect } from 'vitest'
import { createMcpServer, registeredTools } from '../server.js'

const MAX_DESCRIPTION_LEN = 300
const EM_DASH_REGEX = /—/g
const FIRST_SENTENCE_VERB_REGEX = /^[A-Z][a-z]+\s/
const USE_THIS_WHEN_NEEDLE = '. Use this when '

// Ensure createMcpServer has run to populate registeredTools.
// In some test runners the module-scoped mcpServer = createMcpServer() at
// server.ts:98 may not have fired yet; this is a defensive belt-and-braces.
createMcpServer()

describe('Glama TDQS mechanizable rules (D-10.5-15)', () => {
  for (const [toolName, tool] of registeredTools) {
    describe(toolName, () => {
      it('Rule 1 (Conciseness 10%): description length <= 300 chars', () => {
        const desc = tool.description ?? ''
        expect(
          desc.length,
          `${toolName} description is ${desc.length} chars; max ${MAX_DESCRIPTION_LEN}`,
        ).toBeLessThanOrEqual(MAX_DESCRIPTION_LEN)
      })

      it('Rule 2 (em-dash discipline): 0 em-dashes in description', () => {
        const desc = tool.description ?? ''
        const matches = desc.match(EM_DASH_REGEX) ?? []
        expect(
          matches.length,
          `${toolName} description contains ${matches.length} em-dashes; should be 0`,
        ).toBe(0)
      })

      it('Rule 3 (Structure): first sentence starts with capital + lowercase verb form', () => {
        const desc = tool.description ?? ''
        expect(
          desc,
          `${toolName} description should start with a verb-then-object pattern matching /^[A-Z][a-z]+\\s/`,
        ).toMatch(FIRST_SENTENCE_VERB_REGEX)
      })

      it('Rule 4 (Usage Guidelines 20%): contains literal ". Use this when " (D-10.1-03)', () => {
        const desc = tool.description ?? ''
        expect(
          desc.includes(USE_THIS_WHEN_NEEDLE),
          `${toolName} description must contain the literal substring "${USE_THIS_WHEN_NEEDLE.trim()}" per D-10.1-03`,
        ).toBe(true)
      })

      it('Rule 5 (Parameter Semantics 15%): every inputSchema parameter has a non-empty .describe()', () => {
        // tool.inputSchema is the SDK-wrapped ZodObject. Walk via .shape,
        // which exposes the Record<string, ZodTypeAny> map. For tools that
        // take no parameters (e.g., valet_list_services with inputSchema: {}),
        // .shape is an empty object and the for-loop does not iterate.
        const inputSchema = tool.inputSchema as
          | { shape?: Record<string, unknown> }
          | undefined
        if (inputSchema === undefined || inputSchema === null) return
        const shape = inputSchema.shape
        if (shape === undefined || shape === null) return
        for (const [paramName, paramSchema] of Object.entries(shape)) {
          const schemaWithDesc = paramSchema as { description?: string }
          const desc = schemaWithDesc.description ?? ''
          expect(
            desc.length > 0,
            `${toolName}.${paramName} parameter is missing a non-empty .describe() value`,
          ).toBe(true)
        }
      })
    })
  }
})
