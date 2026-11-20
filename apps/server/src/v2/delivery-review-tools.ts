import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DeliveryReviewCandidate, DeliveryReviewEvent, DeliveryReviewState, DeliveryReviewVerdict } from '@minions/contracts';
import * as z from 'zod';
import { getDeliveryReview, mutateDeliveryReview } from '../projects/delivery-review.js';
import type { ProgressActor } from '../projects/progress-authority.js';
import { actorSource, untrusted } from './untrusted.js';

export const DELIVERY_REVIEW_READ_TOOL = 'get_delivery_review';
export const DELIVERY_REVIEW_WRITE_TOOLS = ['submit_delivery_review', 'record_delivery_verdict', 'refresh_delivery_review'] as const;
const taskId = z.string().min(1).max(200);
const requestId = z.string().regex(/^[\w-]{1,64}$/).describe('Create a request ID. Reuse it only to retry the identical submission, verdict or refresh.');
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).describe('The generation from the latest delivery review read.');
type Run = (tool: () => Promise<object>) => Promise<CallToolResult>;

const candidateWithSource = (candidate: DeliveryReviewCandidate) => ({
  ...candidate, manifest: untrusted(actorSource(candidate.submittedBy), candidate.manifest),
  ...(candidate.reportedTests ? { reportedTests: untrusted(actorSource(candidate.submittedBy), candidate.reportedTests) } : {}),
});
const verdictWithSource = (verdict: DeliveryReviewVerdict) => ({
  ...verdict, note: untrusted(actorSource(verdict.actor), verdict.note),
});

export function deliveryReviewWithSource(review: DeliveryReviewState) {
  return { ...review, current: review.current && candidateWithSource(review.current), verdict: review.verdict && verdictWithSource(review.verdict) };
}

function eventWithSource(event: DeliveryReviewEvent) {
  if (event.kind === 'configured' && event.reason !== undefined)
    return { ...event, reason: untrusted(actorSource(event.actor), event.reason) };
  if (event.kind === 'submitted') return { ...event, candidate: candidateWithSource(event.candidate) };
  if (event.kind === 'verdict') return { ...event, verdict: verdictWithSource(event.verdict) };
  return event;
}

export function registerDeliveryReviewTools(server: McpServer, actor: () => ProgressActor, run: Run,
  now: () => number, writable: boolean, uuid: (request: string) => string): void {
  server.registerTool(DELIVERY_REVIEW_READ_TOOL, {
    annotations: { readOnlyHint: true },
    description: 'Read an opted-in task’s current delivery candidate, peer verdict, observed GitHub checks and a page of evidence history. Read the task itself for the current requirements. The manifest and review note are attributed to their authors.',
    inputSchema: { task_id: taskId, cursor: z.string().regex(/^\d{16}$/).optional(), limit: z.number().int().min(1).max(20).optional() },
  }, ({ task_id, cursor, limit }) => run(async () => {
    const { events, nextCursor, ...review } = await getDeliveryReview(actor(), task_id, { cursor, limit }, now);
    return { ...deliveryReviewWithSource(review), events: events.map(eventWithSource), nextCursor };
  }));

  if (!writable) return;
  server.registerTool('submit_delivery_review', {
    description: 'As the assigned agent, submit a pull request and its exact head commit for an opted-in task. The manifest explains how that commit addresses the current task requirements and what you validated.',
    inputSchema: { task_id: taskId, repository: z.string().trim().min(1).max(300).describe('GitHub repository as owner/name.'), pull_request: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      head_sha: z.string().regex(/^[a-fA-F0-9]{40}$/), manifest: z.string().trim().min(1).max(3000),
      reported_tests: z.array(z.object({ path: z.string().min(1).max(240), sha256: z.string().regex(/^[a-fA-F0-9]{64}$/) }).strict())
        .max(20).optional().describe('Tests you report for this commit, by project-relative path and file SHA-256. GitHub observation is separate.'),
      expected_generation: generation, client_request_id: requestId },
  }, input => run(async () => {
    const result = await mutateDeliveryReview(actor(), { operation: 'submit', taskId: input.task_id,
      repository: input.repository, pullRequest: input.pull_request, headSha: input.head_sha,
      manifest: input.manifest, ...(input.reported_tests ? { reportedTests: input.reported_tests } : {}), expectedGeneration: input.expected_generation, clientRequestId: uuid(input.client_request_id) }, now);
    return { ...result, event: eventWithSource(result.event) };
  }));

  server.registerTool('record_delivery_verdict', {
    description: 'As a separate authorized peer, review the candidate at its exact head. For each specified invalid input or failure, try an ordinary caller example and check the observable result. Record the verdict for the reviewed generation.',
    inputSchema: { task_id: taskId, generation, verdict: z.enum(['approved', 'changes_requested']), note: z.string().trim().min(1).max(2000)
      .describe('Summarize what you observed and which requirements, if any, remain unverified.'), client_request_id: requestId },
  }, input => run(async () => {
    const result = await mutateDeliveryReview(actor(), { operation: 'verdict', taskId: input.task_id, generation: input.generation,
      verdict: input.verdict, note: input.note, clientRequestId: uuid(input.client_request_id) }, now);
    return { ...result, event: eventWithSource(result.event) };
  }));

  server.registerTool('refresh_delivery_review', {
    description: 'Ask the engine to read GitHub for the current candidate’s exact head and the task’s pinned checks. Reusing a completed request ID returns its historical receipt. Use get_delivery_review for current evidence.',
    inputSchema: { task_id: taskId, generation, client_request_id: requestId.describe(
      'Use a new ID for a new GitHub observation. Reuse the original ID with identical arguments only to recover the saved refresh receipt.',
    ) },
  }, input => run(async () => {
    const result = await mutateDeliveryReview(actor(), { operation: 'refresh', taskId: input.task_id,
      generation: input.generation, clientRequestId: uuid(input.client_request_id) }, now);
    return { ...result, event: eventWithSource(result.event), ...(result.replayed ? {
      receiptScope: 'historical',
      guidance: 'This is the saved refresh receipt. Call get_delivery_review for current evidence. To ask GitHub for a new observation, use the current generation and a new client_request_id.',
    } : {}) };
  }));
}
