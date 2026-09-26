import { z } from "zod";
import type { Message, Run } from "@openbot/domain";

export const delegateTaskSchema = z.object({
  botId: z.string().uuid(),
  task: z.string().trim().min(1).max(4000),
}).strict();
export type DelegateTaskInput = z.infer<typeof delegateTaskSchema>;
export interface ChannelColleague {
  id: string;
  name: string;
  role: string;
  description: string;
}
export interface AgentCollaborationStore {
  colleagues(run: Run): Promise<{ bots: ChannelColleague[]; truncated: boolean }>;
  delegate(run: Run, input: DelegateTaskInput): Promise<{ run: Run; message: Message }>;
}
export interface DelegationResult {
  runId: string;
  botId: string;
  status: Run["status"];
  result?: string;
  error?: string;
}
