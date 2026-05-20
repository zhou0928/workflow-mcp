import { z } from "zod";

// ============================================================
// Tool Definition Types
// ============================================================

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export type ToolResult =
  | { content: { type: "text"; text: string }[]; isError?: false }
  | { content: { type: "text"; text: string }[]; isError: true };

// ============================================================
// Git Workflow Schemas
// ============================================================

export const GitCreateBranchSchema = z.object({
  baseBranch: z.string().describe("Base branch to create from"),
  newBranchName: z.string().describe("Name for the new branch"),
});

export const GitCreatePRSchema = z.object({
  title: z.string().describe("PR title"),
  body: z.string().optional().describe("PR description / body"),
  head: z.string().describe("Head branch (source)"),
  base: z.string().describe("Base branch (target)"),
  draft: z.boolean().optional().describe("Create as draft PR"),
});

export const GitMergeBranchSchema = z.object({
  sourceBranch: z.string().describe("Source branch to merge from"),
  targetBranch: z.string().describe("Target branch to merge into"),
  method: z
    .enum(["merge", "squash", "rebase"])
    .optional()
    .describe("Merge method"),
});

export const GitAutoCommitSchema = z.object({
  message: z.string().optional().describe("Commit message (auto-generated if omitted)"),
  files: z
    .array(z.string())
    .optional()
    .describe("Specific files to commit (all staged if omitted)"),
  type: z
    .enum(["feat", "fix", "refactor", "docs", "style", "test", "chore"])
    .optional()
    .describe("Conventional commit type"),
  addAll: z.boolean().optional().describe("Auto-add all changes before commit"),
});

export const GitSyncForkSchema = z.object({
  upstreamRemote: z
    .string()
    .default("upstream")
    .describe("Upstream remote name"),
  branch: z.string().optional().describe("Branch to sync (default: current)"),
});

// ============================================================
// File Processing Schemas
// ============================================================

export const FileBatchRenameSchema = z.object({
  directory: z.string().describe("Target directory"),
  pattern: z.string().describe("Search pattern (glob or regex)"),
  replacement: z.string().describe("Replacement string (supports $1, $2 etc.)"),
  useRegex: z.boolean().optional().describe("Use regex instead of glob"),
  dryRun: z.boolean().optional().describe("Preview changes without applying"),
});

export const FileBatchConvertSchema = z.object({
  directory: z.string().describe("Target directory"),
  fromFormat: z.string().describe("Source format extension (e.g. .png)"),
  toFormat: z.string().describe("Target format extension (e.g. .jpg)"),
  recursive: z.boolean().optional().describe("Search subdirectories"),
  keepOriginal: z.boolean().optional().describe("Keep original files"),
});

export const FileCompressSchema = z.object({
  source: z.string().describe("Source file or directory to compress"),
  output: z.string().optional().describe("Output archive path (auto-generated if omitted)"),
  format: z
    .enum(["zip", "tar", "tar.gz", "tar.bz2"])
    .optional()
    .describe("Archive format"),
});

export const FileArchiveSchema = z.object({
  source: z.string().describe("Source file or directory to organize"),
  destination: z.string().optional().describe("Destination directory"),
  organizeBy: z
    .enum(["date", "type", "size"])
    .optional()
    .describe("Organization strategy"),
});

export const FileFindDuplicatesSchema = z.object({
  directory: z.string().describe("Directory to scan"),
  namePattern: z.string().optional().describe("Filter by name pattern"),
  minSize: z
    .number()
    .optional()
    .describe("Minimum file size in bytes"),
});

// ============================================================
// Deployment Schemas
// ============================================================

export const DeployRunSchema = z.object({
  environment: z.string().describe("Target environment (e.g. staging, production)"),
  branch: z.string().optional().describe("Branch to deploy"),
  script: z.string().optional().describe("Custom deploy script path"),
  vars: z
    .record(z.string())
    .optional()
    .describe("Environment variables for deployment"),
});

export const DeployRollbackSchema = z.object({
  environment: z.string().describe("Environment to rollback"),
  version: z.string().optional().describe("Specific version to rollback to"),
});

export const DeployStatusSchema = z.object({
  environment: z.string().describe("Environment to check"),
});

export const DeployListSchema = z.object({
  environment: z.string().optional().describe("Filter by environment"),
  limit: z.number().optional().describe("Max results to return"),
});

// ============================================================
// Code Review Schemas
// ============================================================

export const ReviewRunLintSchema = z.object({
  directory: z.string().describe("Project directory"),
  config: z.string().optional().describe("Linter config file path"),
  fix: z.boolean().optional().describe("Auto-fix issues"),
});

export const ReviewRunTestsSchema = z.object({
  directory: z.string().describe("Project directory"),
  testPattern: z.string().optional().describe("Test file pattern"),
  coverage: z.boolean().optional().describe("Generate coverage report"),
  command: z.string().optional().describe("Custom test command"),
});

export const ReviewGenerateReportSchema = z.object({
  directory: z.string().describe("Project directory"),
  output: z.string().optional().describe("Output file path"),
  includeLint: z.boolean().optional().describe("Include lint results"),
  includeTests: z.boolean().optional().describe("Include test results"),
  includeDeps: z.boolean().optional().describe("Include dependency audit"),
});

export const ReviewCheckStyleSchema = z.object({
  directory: z.string().describe("Project directory"),
  config: z.string().optional().describe("Formatter config"),
  check: z.boolean().optional().describe("Check only, don't format"),
});

// ============================================================
// ETL Schemas
// ============================================================

export const EtlExtractSchema = z.object({
  sourceType: z
    .enum(["csv", "json", "database", "api", "file"])
    .describe("Source data type"),
  sourceConfig: z.record(z.string()).describe("Source connection config"),
  output: z.string().optional().describe("Output file for extracted data"),
  query: z.string().optional().describe("Filter/query for extraction"),
});

export const EtlTransformSchema = z.object({
  input: z.string().describe("Input file path"),
  rules: z
    .array(
      z.object({
        field: z.string(),
        operation: z.enum([
          "rename",
          "remove",
          "cast",
          "default",
          "map",
          "filter",
        ]),
        params: z.record(z.unknown()).optional(),
      })
    )
    .describe("Transformation rules"),
  output: z.string().optional().describe("Output file path"),
  format: z.enum(["json", "csv"]).optional().describe("Output format"),
});

export const EtlLoadSchema = z.object({
  input: z.string().describe("Input data file path"),
  destinationType: z
    .enum(["json", "csv", "database", "api"])
    .describe("Destination type"),
  destinationConfig: z
    .record(z.string())
    .describe("Destination connection config"),
  mode: z
    .enum(["append", "replace", "merge"])
    .optional()
    .describe("Load mode"),
});

export const EtlRunPipelineSchema = z.object({
  name: z.string().describe("Pipeline name"),
  configPath: z.string().optional().describe("Pipeline config file path"),
  config: z
    .string()
    .optional()
    .describe("Inline JSON pipeline configuration"),
  vars: z.record(z.string()).optional().describe("Pipeline variables"),
});

// ============================================================
// Scheduler Schemas
// ============================================================

export const ScheduleAddSchema = z.object({
  name: z.string().describe("Task name"),
  cron: z.string().describe("Cron expression"),
  command: z.string().optional().describe("Shell command to run"),
  tool: z.string().optional().describe("MCP tool name to call"),
  toolArgs: z.record(z.unknown()).optional().describe("Arguments for the tool"),
  description: z.string().optional().describe("Task description"),
});

export const ScheduleRemoveSchema = z.object({
  name: z.string().describe("Task name to remove"),
});

export const ScheduleListSchema = z.object({});

export const ScheduleRunNowSchema = z.object({
  name: z.string().describe("Task name to run immediately"),
});

// ============================================================
// Notification & Messaging Schemas
// ============================================================

export const NotificationSendSchema = z.object({
  channel: z.string().describe("Notification channel (e.g. slack, email, webhook)"),
  title: z.string().describe("Notification title"),
  message: z.string().describe("Notification message body"),
  priority: z.enum(["low", "normal", "high", "critical"]).optional().describe("Message priority"),
});

export const NotificationSendMultiSchema = z.object({
  channels: z.array(z.string()).describe("List of target channels"),
  title: z.string().describe("Notification title"),
  message: z.string().describe("Notification message body"),
  priority: z.enum(["low", "normal", "high", "critical"]).optional().describe("Message priority"),
});

export const NotificationListChannelsSchema = z.object({
  source: z.string().optional().describe("Filter by notification source"),
});

// ============================================================
// Package Management Schemas
// ============================================================

export const PkgInstallSchema = z.object({
  name: z.string().describe("Package name to install"),
  manager: z.enum(["npm", "pip", "brew", "cargo", "go"]).describe("Package manager to use"),
  version: z.string().optional().describe("Specific version to install"),
  dev: z.boolean().optional().describe("Install as dev dependency"),
  global: z.boolean().optional().describe("Install globally"),
});

export const PkgRemoveSchema = z.object({
  name: z.string().describe("Package name to remove"),
  manager: z.enum(["npm", "pip", "brew", "cargo", "go"]).describe("Package manager to use"),
  global: z.boolean().optional().describe("Remove globally"),
});

export const PkgUpdateSchema = z.object({
  name: z.string().optional().describe("Package name to update (all if omitted)"),
  manager: z.enum(["npm", "pip", "brew", "cargo", "go"]).describe("Package manager to use"),
});

export const PkgListSchema = z.object({
  manager: z.enum(["npm", "pip", "brew", "cargo", "go"]).describe("Package manager to query"),
  filter: z.string().optional().describe("Optional filter/search term"),
  global: z.boolean().optional().describe("List globally installed packages"),
});

// ============================================================
// Reporting Schemas
// ============================================================

export const ReportGenerateSchema = z.object({
  type: z.enum(["coverage", "summary", "full", "custom"]).describe("Report type"),
  format: z.enum(["markdown", "json", "html"]).describe("Output format"),
  output: z.string().optional().describe("Output file path"),
  data: z.string().optional().describe("Inline JSON data for the report"),
  title: z.string().optional().describe("Report title"),
});

export const ReportScheduleSchema = z.object({
  cron: z.string().optional().describe("Cron expression for scheduling (omit for one-off)"),
  reportType: z.enum(["coverage", "summary", "full", "custom"]).describe("Report type to schedule"),
  format: z.enum(["markdown", "json", "html"]).describe("Output format"),
  output: z.string().optional().describe("Output directory for scheduled reports"),
});

export const ReportListSchema = z.object({
  type: z.string().optional().describe("Filter by report type"),
});

// ============================================================
// Testing Schemas
// ============================================================

export const TestRunSchema = z.object({
  pattern: z.string().optional().describe("Test file pattern (e.g. 'src/**/*.test.ts')"),
  coverage: z.boolean().optional().describe("Generate coverage report"),
  command: z.string().optional().describe("Custom test command (overrides auto-detection)"),
  directory: z.string().optional().describe("Project directory"),
});

export const TestWatchSchema = z.object({
  pattern: z.string().optional().describe("Test file pattern to watch"),
  command: z.string().optional().describe("Custom watch command"),
  directory: z.string().optional().describe("Project directory"),
});

export const TestListSchema = z.object({
  filter: z.string().optional().describe("Optional filter text"),
  directory: z.string().optional().describe("Project directory"),
});

// ============================================================
// API Integration Schemas
// ============================================================

export const ApiRequestSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]).describe("HTTP method"),
  url: z.string().describe("Request URL"),
  headers: z.record(z.string()).optional().describe("Request headers"),
  body: z.string().optional().describe("Request body (JSON string)"),
  timeout: z.number().optional().describe("Request timeout in milliseconds"),
});

export const ApiCollectionRunSchema = z.object({
  collection: z.string().optional().describe("Path to API collection file (Postman/OpenAPI)"),
  environment: z.string().optional().describe("Environment variables file"),
  endpoint: z.string().optional().describe("Single endpoint to test"),
});

export const ApiExportSchema = z.object({
  format: z.enum(["openapi", "postman"]).describe("Export format"),
  source: z.string().describe("Source file or URL to convert"),
  output: z.string().optional().describe("Output file path"),
});

export const ApiHealthCheckSchema = z.object({
  url: z.string().describe("Health check endpoint URL"),
  timeout: z.number().optional().describe("Request timeout in milliseconds"),
  expectedStatus: z.number().optional().describe("Expected HTTP status code"),
});

// ============================================================
// Observability Schemas
// ============================================================

export const ObsLogsSchema = z.object({
  source: z.string().describe("Log source (e.g. 'app', 'system', 'nginx')"),
  level: z.enum(["debug", "info", "warn", "error"]).optional().describe("Minimum log level"),
  tail: z.number().optional().describe("Number of recent lines to fetch"),
  filter: z.string().optional().describe("Search filter for log content"),
  follow: z.boolean().optional().describe("Follow new log entries (tail -f)"),
});

export const ObsMetricsSchema = z.object({
  source: z.string().describe("Metrics source (e.g. 'cpu', 'memory', 'disk', 'network')"),
  period: z.string().optional().describe("Time period (e.g. '5m', '1h', '24h')"),
});

export const ObsHealthSchema = z.object({
  service: z.string().optional().describe("Service name to check (all if omitted)"),
});

export const ObsAlertSchema = z.object({
  message: z.string().describe("Alert message"),
  severity: z.enum(["info", "warning", "critical"]).describe("Alert severity"),
  source: z.string().optional().describe("Alert source identifier"),
  metadata: z.record(z.string()).optional().describe("Additional alert metadata"),
});

// ============================================================
// Container / Docker Schemas
// ============================================================

export const DockerBuildSchema = z.object({
  directory: z.string().describe("Project directory with Dockerfile"),
  tag: z.string().describe("Image tag (e.g. myapp:latest)"),
  dockerfile: z.string().optional().describe("Dockerfile path relative to directory (default: Dockerfile)"),
  buildArgs: z.record(z.string()).optional().describe("Build arguments (e.g. NODE_VERSION=18)"),
  noCache: z.boolean().optional().describe("Disable layer caching"),
});

export const DockerPushSchema = z.object({
  tag: z.string().describe("Image tag to push"),
  registry: z.string().optional().describe("Registry URL"),
  username: z.string().optional().describe("Registry username"),
  password: z.string().optional().describe("Registry password or token"),
});

export const DockerComposeUpSchema = z.object({
  directory: z.string().describe("Project directory with docker-compose.yml"),
  services: z.array(z.string()).optional().describe("Specific services to start"),
  detach: z.boolean().optional().describe("Run in detached mode (default: true)"),
  envFile: z.string().optional().describe("Environment file path"),
  build: z.boolean().optional().describe("Build images before starting"),
});

export const DockerComposeDownSchema = z.object({
  directory: z.string().describe("Project directory with docker-compose.yml"),
  removeVolumes: z.boolean().optional().describe("Remove named volumes"),
  removeImages: z.boolean().optional().describe("Remove images used by services"),
});

// ============================================================
// Scaffold Schemas
// ============================================================

export const ScaffoldInitSchema = z.object({
  template: z.string().describe("Template name (e.g. vue3-app, node-ts, react-app, next-app, express-api)"),
  name: z.string().describe("Project name"),
  outputDir: z.string().optional().describe("Output directory (default: ./<name>)"),
  vars: z.record(z.string()).optional().describe("Template variables"),
  force: z.boolean().optional().describe("Overwrite existing directory"),
});

export const ScaffoldAddModuleSchema = z.object({
  module: z.string().describe("Module type (e.g. vue-component, vite-plugin, express-route)"),
  name: z.string().describe("Module name"),
  directory: z.string().optional().describe("Project directory (default: cwd)"),
});

// ============================================================
// Secrets Schemas
// ============================================================

export const SecretGetSchema = z.object({
  key: z.string().describe("Secret key to retrieve"),
  profile: z.string().optional().describe("Profile/environment name (default: 'default')"),
});

export const SecretSetSchema = z.object({
  key: z.string().describe("Secret key"),
  value: z.string().describe("Secret value"),
  profile: z.string().optional().describe("Profile/environment name (default: 'default')"),
});

export const SecretListSchema = z.object({
  profile: z.string().optional().describe("Profile/environment name (default: all profiles)"),
});

export const SecretRemoveSchema = z.object({
  key: z.string().describe("Secret key to remove"),
  profile: z.string().optional().describe("Profile/environment name (default: 'default')"),
});

// ============================================================
// Webhook Schemas
// ============================================================

export const WebhookListenSchema = z.object({
  port: z.number().optional().describe("Port to listen on (default: 8080)"),
  path: z.string().optional().describe("Webhook path (default: /webhook)"),
  timeout: z.number().optional().describe("Listen duration in seconds (default: 300)"),
  secret: z.string().optional().describe("HMAC-SHA256 secret for signature verification"),
});

export const WebhookFireSchema = z.object({
  url: z.string().describe("Webhook target URL"),
  payload: z.record(z.unknown()).describe("JSON payload to send"),
  headers: z.record(z.string()).optional().describe("Custom headers"),
  secret: z.string().optional().describe("HMAC secret for signing"),
  method: z.enum(["POST", "PUT", "PATCH"]).optional().describe("HTTP method (default: POST)"),
});

// ============================================================
// Documentation Schemas
// ============================================================

export const DocGenerateSchema = z.object({
  source: z.string().describe("Source directory or file to document"),
  output: z.string().describe("Output directory for generated docs"),
  format: z.enum(["typedoc", "jsdoc", "markdown"]).describe("Documentation format"),
  name: z.string().optional().describe("Project name"),
});

export const DocServeSchema = z.object({
  source: z.string().describe("Directory containing documentation to serve"),
  port: z.number().optional().describe("Server port (default: 3000)"),
});

export const DocCheckSchema = z.object({
  source: z.string().describe("Source directory to check"),
  checks: z.array(z.enum(["missing", "stale", "broken-refs"])).optional().describe("Checks to perform"),
});
