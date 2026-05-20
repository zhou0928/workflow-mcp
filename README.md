# workflow-mcp

An MCP (Model Context Protocol) server providing 6 workflow automation domains with 26 tools.

## Workflows

| Workflow | Description |
|----------|-------------|
| **Git** | Branch management, commit, sync fork, status, diff, log, stash |
| **File Processing** | Watch directories, read/write files with ignore patterns |
| **Code Review** | Review diffs by severity, generate review reports |
| **Deployment** | Validate configs, execute rollouts, rollback on failure |
| **ETL** | Extract, transform, load pipelines with scheduling |
| **Scheduler** | Cron-based task scheduling with persistence |

## Usage

```bash
npm run build
npm start
```

The server communicates over stdio transport — compatible with any MCP client.

## Build

```bash
npm run build    # Compile TypeScript → dist/
npm run dev      # Watch mode
```

## Test

```bash
npx vitest run
```

## Tools

26 tools are registered at startup across the 6 workflow modules. Logged to stderr on start.

## License

MIT
