/**
 * lib/generate-citations.ts
 *
 * Lightweight second-pass Claude call that generates one key published study
 * citation per formulation ingredient. Runs AFTER the main formulation call
 * succeeds so citation generation has zero impact on formulation arithmetic.
 *
 * Failure is graceful — the caller catches errors and returns the formulation
 * without citations rather than failing the whole response.
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

export interface IngredientForCitation {
  ingredient_name: string;
  /** Concise clinical context — target biomarker findings, truncated rationale. */
  clinical_context: string;
}

export interface CitationResult {
  ingredient_name: string;
  /** "First Author et al. (Year). Title or key finding. Journal Name." */
  citation: string;
  [key: string]: unknown;
}

const CitationsOutputSchema = z.object({
  citations: z.array(
    z.object({
      ingredient_name: z.string(),
      citation: z.string(),
    }),
  ),
});

const TOOL_NAME = 'submit_citations';

const SYSTEM_PROMPT = `You are a clinical research assistant supporting an Australian precision nutrition service. Given a list of supplement ingredients and brief clinical context, provide one key peer-reviewed published study per ingredient that directly supports its use for the stated context.

Format each citation as: "First Author et al. (Year). Title or key finding. Journal Name."

Rules:
- One citation per ingredient — the single most directly relevant study
- Prefer systematic reviews, RCTs, and well-established mechanistic studies over case reports or animal studies
- Do NOT include PMIDs, DOIs, or URLs — the practitioner verifies independently via PubMed
- If no directly relevant published human study exists, return an empty string for that ingredient's citation field rather than citing tangential work
- Return exactly one entry per ingredient supplied, in the same order`;

export async function generateCitations(
  ingredients: IngredientForCitation[],
  client?: Anthropic,
): Promise<CitationResult[]> {
  if (ingredients.length === 0) return [];

  const apiClient =
    client ?? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const ingredientList = ingredients
    .map((ing, i) => `${i + 1}. ${ing.ingredient_name} — ${ing.clinical_context}`)
    .join('\n');

  const userMessage =
    `Provide one key published study citation for each ingredient below.\n\n${ingredientList}`;

  const toolInputSchema = {
    type: 'object' as const,
    properties: {
      citations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ingredient_name: { type: 'string' },
            citation: { type: 'string' },
          },
          required: ['ingredient_name', 'citation'],
        },
      },
    },
    required: ['citations'],
  };

  const response = await apiClient.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: [
      {
        name: TOOL_NAME,
        description: 'Submit one citation per ingredient in the order supplied.',
        input_schema: toolInputSchema,
      },
    ],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages: [{ role: 'user', content: userMessage }],
  });

  const toolBlock = response.content.find((b) => b.type === 'tool_use');
  if (!toolBlock || toolBlock.type !== 'tool_use') {
    throw new Error(
      `Citation call returned no tool_use block (stop_reason: ${response.stop_reason})`,
    );
  }

  const parsed = CitationsOutputSchema.safeParse(toolBlock.input);
  if (!parsed.success) {
    throw new Error(
      `Citation output failed validation: ${JSON.stringify(parsed.error.issues)}`,
    );
  }

  // Drop entries with empty citations — they add no value to the document.
  return parsed.data.citations.filter((c) => c.citation.trim().length > 0);
}
