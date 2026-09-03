/**
 * Programmatic API.
 *
 * Everything the CLI does is available here, so web-drifter can be embedded in
 * a bespoke pipeline - a custom gate, a scheduled job, a dashboard feed -
 * without shelling out and parsing stdout.
 */

// Configuration
export { defineConfig, configSchema } from './config/schema.js';
export type { DrifterConfig, DrifterConfigInput } from './config/schema.js';
export { loadConfig, parseConfig } from './config/load.js';
export {
  BUILT_IN_DEVICES,
  DEFAULT_VIEWPORT_IDS,
  PRIMARY_VIEWPORT_ID,
  resolveDevices,
  listBuiltInDeviceIds,
} from './config/devices.js';
export type { DeviceProfile } from './config/devices.js';

// Core types and errors
export type {
  ContentNode,
  Finding,
  FindingCategory,
  PageSnapshot,
  PageStats,
  RunStats,
  Severity,
  Side,
} from './core/types.js';
export {
  BrowserError,
  CaptureError,
  ConfigError,
  DrifterError,
  StoreError,
} from './core/errors.js';
export { createLogger, silentLogger } from './core/logger.js';
export type { Logger, LogLevel } from './core/logger.js';

// Pipeline stages
export {
  runAll,
  runCrawl,
  runCompare,
  runReportStage,
  toSelfComparisonConfig,
} from './pipeline.js';
export type { CrawlResult, CompareResult, FullRunResult, StageContext } from './pipeline.js';

// Store
export { ArtifactStore, generateRunId, listRuns, pathSlug } from './store/artifact-store.js';

// Comparison, for callers building their own reporting
export { compareRun } from './compare/engine.js';
export {
  applySuppression,
  createFinding,
  sortFindings,
  DEFAULT_SEVERITIES,
} from './compare/findings.js';

// Reporting
export { writeReport, exitCodeFor, summarise, REPORT_SCHEMA_VERSION } from './report/write.js';
export type { WriteReportOptions, WriteReportResult } from './report/write.js';
export { aggregate } from './report/aggregate.js';
export type { ReportModel, PageReport, DeviceReport, MatrixRow } from './report/aggregate.js';
export { diffRuns, atOrAbove, countBySeverity } from './report/diff.js';
export type { RunDiff, RunSummary, ChangedFinding, ReportFile } from './report/diff.js';
export { renderDiffMarkdown } from './report/diff-markdown.js';
