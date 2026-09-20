/**
 * Permission classes, ordered from least to most dangerous. The worker's
 * canUseTool callback maps every proposed tool call onto exactly one of these,
 * and policy decides allow / ask / deny per class.
 */
export const PERMISSION_CLASSES = [
  'READ_ONLY',
  'LOCAL_REVERSIBLE',
  'EXTERNAL_SIDE_EFFECT',
  'DESTRUCTIVE',
  'PROHIBITED',
] as const;

export type PermissionClass = (typeof PERMISSION_CLASSES)[number];

export type PermissionAction = 'allow' | 'ask' | 'deny';

export interface PermissionClassification {
  class: PermissionClass;
  /** Why the classifier chose this class, for logs and approval prompts. */
  reason: string;
  /** Redacted, speech-friendly description of what would happen. */
  summary: string;
  /** Paths the call would touch, resolved to absolute form. */
  paths?: string[];
}

export interface PermissionDecision {
  action: PermissionAction;
  classification: PermissionClassification;
  /** Populated when action is 'deny'. */
  denyReason?: string;
}
