/** Diagnostics + resources — spec §3.4/§40/§50. */
import type { HealthState, ResourceMode } from './capabilities.js';

export interface ComponentStatus {
  id: string;
  label: string;
  state: HealthState;
  message: string;
  /** Actionable recovery hints (§50). */
  hints: string[];
  updatedAt: string;
}

export interface GpuSample {
  name: string;
  utilPercent?: number;
  vramUsedMb?: number;
  vramTotalMb?: number;
}

export interface ResourceSnapshot {
  sampledAt: string;
  cpuPercent?: number;
  memTotalMb: number;
  memUsedMb: number;
  /** Undefined on machines without measurable GPU (then honestly hidden). */
  gpus?: GpuSample[];
  /** Sum of model sizes reported resident by providers, when available. */
  residentModelBytes?: number;
  resourceMode: ResourceMode;
  activeTasks: number;
  indexingActive: boolean;
}

export interface HealthReport {
  overall: HealthState;
  components: ComponentStatus[];
  resources: ResourceSnapshot;
  generatedAt: string;
}
