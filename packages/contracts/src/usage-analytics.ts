export const PROMPT_SOURCES = ["mission", "runtime", "steering", "deliveryNotices", "permissions", "project", "persona", "attribution", "unattributed"] as const;
export const CONTEXT_TOOL_NAMES = ["get_project", "find_agents", "read_agent_inbox", "send_message", "set_agent_status", "read_thread", "list_tasks", "get_task", "create_task", "update_task", "claim_task", "release_task", "comment_task", "link_task", "request_human_help", "list_human_requests", "acknowledge_human_answer", "resolve_human_request", "record_work_intent", "list_work_intents", "publish_project_update", "list_project_updates", "read_teams", "manage_team", "upload_project_image", "set_project_preview", "get_mlswarm_guide"] as const;
export type PromptSource = typeof PROMPT_SOURCES[number];
export type ContextToolName = typeof CONTEXT_TOOL_NAMES[number];
export const CONTEXT_TOOL_CATEGORIES = ['project','discovery','updates','threads','messaging','checkpoints','coordination','other'] as const;
export type ContextToolCategory = typeof CONTEXT_TOOL_CATEGORIES[number];
export type ContextToolTotals = { calls:number;argumentBytes:number;responseTextBytes:number;refusals:number };
/** Received-report analytics. UTC completion days; never proof of offline-turn completeness. */
export const USAGE_METRICS = ['input','output','cacheRead','cacheWrite','seconds','toolCalls','instructionBytes','turnPromptBytes','catalogBytes','toolResponseBytes','steeringBytes','conversationResponseBytes','taskResponseBytes'] as const;
export type UsageMetric = typeof USAGE_METRICS[number];
export type AnalyticsMeasure = { sum: number; known: number; partial: number };
export type McpToolTotals = ContextToolTotals & {catalogDeliveries:number;definitionBytes:number};
export type AnalyticsValues = { nativeReports:number;nativeLastInputMax:number|null;nativeCompactions:number; promptSourceReports:number;promptSources:Record<PromptSource,number>;mcpReports:number;mcpTools:Partial<Record<ContextToolName,McpToolTotals>>; reports: number; outcomes: Record<'succeeded'|'failed'|'timed_out'|'budget_cap',number>; metrics: Record<UsageMetric,AnalyticsMeasure> };
export type UsageAnalytics = {
  schema: 1; timeBasis: 'reported-completion-utc'; scope: 'project'|'platform'; projectId: string|null;
  from: string; to: string; generatedAt: number; lastProjectedAt: number|null;
  coverage: 'projected-received-reports'; historyCoverage: 'not-verified'; pendingReports: number; pendingReportsCapped: boolean; contextScope: 'partial-mlswarm-supplied';
  totals: AnalyticsValues; points: (AnalyticsValues & {day:string})[];
  groups: (AnalyticsValues & {key:string;label:string;provider:string;model:string|null;projectId:string|null})[];
};
export type ContextSummary = {
  scope?:'mlswarm-supplied';coverage?:'partial';instructionBytes:number;turnPromptBytes:number;catalogRequests:number;catalogBytes:number;
  promptSources?:Record<PromptSource,number>;steeringMessages?:number;sessionMode?:'new'|'resumed';
  tools:({category:ContextToolCategory}&ContextToolTotals)[];
  byTool?:({name:ContextToolName}&McpToolTotals)[];
};
export type ContextRunPage = {runs:{agentId:string;agentName:string|null;runId:string;startedAt:number;endedAt:number|null}[];nextCursor:string|null};
export type ContextTurnPage = {turns:{sequence:number;endedAt:number;outcome:string;provider:string;model:string|null;nativeContext:NativeContextObservation|null;context:ContextSummary|null}[];nextSequence:number|null};
/** Latest run of each recently active agent (up to 12) with its last 12 turns, oldest first. */
export type ContextNow = {agents:(ContextRunPage['runs'][number]&{turns:ContextTurnPage['turns']})[]};

/** Exact native field observations; last/total do not establish occupied context or capacity remaining. */
export type NativeContextObservation = {source:'codex-app-server'|'claude-stream-json';coverage:'partial-turn-stream';lastInputTokens:number|null;lastTotalTokens:number|null;modelContextWindow:number|null;observations:number;completedCompactions:number};
