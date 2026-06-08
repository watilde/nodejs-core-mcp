# node-core-mcp

An [MCP](https://modelcontextprotocol.io/) server that gives AI assistants hands-on access to a local [nodejs/node](https://github.com/nodejs/node) checkout — build, test, search, and review, all from the conversation.

## Requirements

- Node.js ≥ 18
- A local clone of `nodejs/node`
- `gh` CLI (only for `get_pr_metadata`)

## Installation

```bash
npm install -g node-core-mcp
```

Or use directly with `npx`:

```bash
npx node-core-mcp --repo /path/to/node
```

## MCP configuration

By default (no `--repo` flag), the server resolves the repo root as three directories above the `bin/` folder — which works when the package lives inside the repo at `tools/node-core-mcp/`.

### Claude Code

`~/.claude/settings.json` (global) or `.claude/settings.json` (project):

```json
{
  "mcpServers": {
    "node-core": {
      "command": "node-core-mcp",
      "args": ["--repo", "/absolute/path/to/nodejs/node"]
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "node-core": {
      "command": "node-core-mcp",
      "args": ["--repo", "/absolute/path/to/nodejs/node"]
    }
  }
}
```

### VS Code

Requires VS Code 1.99+ with the GitHub Copilot extension. `.vscode/mcp.json`:

```json
{
  "servers": {
    "node-core": {
      "type": "stdio",
      "command": "node-core-mcp",
      "args": ["--repo", "${workspaceFolder}/../node"]
    }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.node-core]
command = "node-core-mcp"
args = ["--repo", "/absolute/path/to/nodejs/node"]
```

## Tools

### Build

| Tool | Description |
|------|-------------|
| `configure` | Run `./configure` (accepts `debug`, `extra_flags`) |
| `build` | Run `make` (accepts `target`, `jobs`) |
| `run_lint` | Run `make lint-js`, `make lint-cpp`, or `make lint` |
| `get_node_version` | Get the version of the local dev build (falls back to system Node.js) |

### Test

| Tool | Description |
|------|-------------|
| `run_test` | Run a single test file with the dev binary |
| `run_tests` | Run tests matching a pattern via `tools/test.py` |
| `run_benchmark` | Run a benchmark file with the dev binary |
| `explain_test_failure` | Parse TAP / `tools/test.py` output and return failures + re-run commands |

### Code search

| Tool | Description |
|------|-------------|
| `search_code` | `grep -rn` across `lib/`, `src/`, `test/` (or a custom dir) |
| `read_file` | Read a source file (supports `offset` and `limit` for large files) |
| `git_log` | Show recent commit history, optionally filtered by path |

### Documentation

| Tool | Description |
|------|-------------|
| `list_docs` | List Markdown files in `doc/api/` |
| `read_doc` | Read a single API doc (e.g. `stream.md`) |
| `search_docs` | Search `doc/api/`, `doc/contributing/`, and `test/README.md` |

### PR & subsystem

| Tool | Description |
|------|-------------|
| `find_subsystem` | Given changed files, identify the primary subsystem, likely reviewers, and PR labels |
| `list_relevant_tests` | Given changed files, suggest which test commands to run |
| `get_pr_metadata` | Fetch labels, CI status, reviews, and commits for a `nodejs/node` PR via `gh` |

## Development

```bash
# Run the test suite
npm test
```

## License

MIT
