---
title: "Supported Tools"
weight: 20
description: "AI coding tools that AI Engineer Coach can analyze"
---

# Supported Tools

AI Engineer Coach reads local log files from the following AI coding assistants. No network requests are made; all data stays on your machine.

## Local Agent (VS Code and VS Code Insiders)

The primary harness. AI Engineer Coach parses the chat panel logs that GitHub Copilot writes to the VS Code extension host log directory. This captures every request, response, model used, token counts, tool calls, file references, and terminal commands.

When VS Code connects through Remote-WSL, Remote-SSH, or a Dev Container, the logs live on the remote host under `~/.vscode-server/data/User/workspaceStorage/` (or `~/.vscode-server-insiders/data/User/workspaceStorage/` for Insiders) and appear in the dashboard as `Local Agent (Server)` or `Local Agent (Server Insiders)`.

**What is tracked:**
- Requests and responses with timestamps
- Model selection (e.g., `claude-opus-4.6`, `gpt-5.4`, `auto`)
- Tool calls and slash commands used
- File context references (`#file`, open editor tabs)
- Terminal command execution
- Turn-by-turn conversation structure

## Claude

Parses session files from Anthropic's Claude CLI tool. Each session is read as a structured conversation with tool use, file edits, and terminal commands.

## Codex

Reads session history from OpenAI's Codex terminal agent. Captures prompts, completions, and tool interactions.

## OpenCode

Parses session logs from the open-source OpenCode terminal tool that supports multiple LLM backends.

## GitHub Copilot for Xcode

Reads Copilot Chat conversation logs from Apple's Xcode IDE. Sessions are parsed from SQLite databases stored in the GitHub Copilot configuration directory.

## GitHub Copilot CLI

Parses session state and history files from the GitHub Copilot CLI terminal agent. Captures prompts, completions, model usage, and per-model token metrics reported at session shutdown.

The GitHub Copilot App uses the same event-log format and is shown as a separate harness in the dashboard.

## Coding Moments images

Coding Moments counts image attachments on user turns and loads the original images locally when you open the gallery:

| Harness | Recorded image sources |
|---|---|
| VS Code and Insiders, including remote hosts | Chat image variables in JSON or JSONL, including attachment patches |
| GitHub Copilot CLI and App | User-event attachments and image variables, matched to the corresponding conversation turn |
| Claude | Inline image content, including image-only turns and merged subagent transcripts |
| Codex | User image content and local image attachments; mirrored event records count only once |
| OpenCode | Image file parts in legacy JSON storage or current SQLite databases |
| Xcode | Stored image references on user turns |

Image extraction runs in the existing parse worker, not on the extension-host thread. Raw image payloads are not stored in the analytics cache. Extraction returns at most four images per turn, with a 10 MB limit per image. Local PNG, JPEG, GIF, WebP, BMP, and AVIF images are supported. Reconstructing raw VS Code JSON or JSONL state is limited to 50 MB per session file.

An attachment can still be counted when its original file has been deleted, its payload was not retained, or it exceeds the size limit. Such attachments cannot be displayed. Remote image URLs and network shares are never fetched, and SVG content is not rendered. Session logs and attachment files are never modified.

## Workspace Filtering

You can filter analytics to a single workspace or view aggregated data across all workspaces. The bottom-left panel in the UI provides workspace and harness selectors.
