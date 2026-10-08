/** Permission system — spec §11 / §36. */
import type { PermissionMode } from './capabilities.js';

export type PermissionId =
  | 'fs.read'
  | 'fs.write'
  | 'fs.delete'
  | 'commands.execute'
  | 'programs.launch'
  | 'screen.inspect'
  | 'screen.capture'
  | 'mic.access'
  | 'network.access'
  | 'project.modify'
  | 'software.install';

export const ALL_PERMISSIONS: PermissionId[] = [
  'fs.read',
  'fs.write',
  'fs.delete',
  'commands.execute',
  'programs.launch',
  'screen.inspect',
  'screen.capture',
  'mic.access',
  'network.access',
  'project.modify',
  'software.install',
];

export type RuleDecision = 'allow' | 'ask' | 'deny';

export interface PermissionRequest {
  id: string;
  permission: PermissionId;
  /** What the AI wants to do, human readable. */
  action: string;
  /** Concrete detail: path, command line, region, etc. */
  detail: string;
  taskId?: string;
  createdAt: string;
  /** True when the command matched the dangerous-pattern list. */
  flaggedDangerous?: boolean;
}

export type PermissionDecision = 'allow_once' | 'allow_session' | 'allow_persistent' | 'deny';

export interface PermissionGrant {
  permission: PermissionId;
  decision: 'allow' | 'deny';
  /** 'session' entries are not persisted. */
  scope: 'persistent';
  updatedAt: string;
}

export interface PermissionState {
  mode: PermissionMode;
  grants: PermissionGrant[];
  pending: PermissionRequest[];
  /** Resolved effective rule per permission for display. */
  effective: Record<string, RuleDecision>;
}
