# Yamakawa Code

A Claude Code–style chat sidebar for VS Code, powered by any OpenAI-compatible endpoint.

## Features

- Sidebar chat view with a refined, Claude-inspired UI.
- Streaming responses with a smooth typewriter effect.
- Markdown rendering (headings, lists, code blocks, inline code, links).
- Per-workspace conversation history with one-click clear.
- Multi-provider support: OpenAI-compatible, Anthropic, Gemini, and Ollama.
- File attachments in chat (images and text files).
- Configurable provider, base URL, model, system prompt, and temperature.

## Defaults

- Provider: `openai`
- Base URL: `https://apic1.ohmycdn.com/v1`
- Model: `gpt-5.2`

## Configuration

Open Settings and search for **Yamakawa Code** to customize:

- `yamakawaCode.provider`
- `yamakawaCode.baseUrl`
- `yamakawaCode.model`
- `yamakawaCode.apiKey`
- `yamakawaCode.systemPrompt`
- `yamakawaCode.temperature`
- `yamakawaCode.workspaceTools`

API key fallback by provider (when `yamakawaCode.apiKey` is empty):

- `openai`: `OPENAI_API_KEY` -> `OHMYGPT_API_KEY`
- `anthropic`: `ANTHROPIC_API_KEY` -> `CLAUDE_API_KEY`
- `gemini`: `GEMINI_API_KEY` -> `GOOGLE_API_KEY` -> `GOOGLE_GENERATIVE_AI_API_KEY`
- `ollama`: no API key required

## Development

```bash
npm install
npm run compile
```

## One-Command Setup (For New Contributors)

After cloning this repository, people only need to run one command to set up:

```bash
python3 scripts/bootstrap_project.py
```

Or:

```bash
npm run bootstrap
```

What each helper script is for:

- `scripts/bootstrap_project.py`: install dependencies and compile the project.
- `scripts/update_github.py`: commit + pull --rebase + push safely.
- `scripts/publish_extension.py`: build and publish the VS Code extension.

## Release

Set Marketplace token first:

```bash
export VSCE_PAT=your_marketplace_pat
```

Then use one command:

```bash
npm run release:patch
```

Or publish through Python helper:

```bash
python3 scripts/publish_extension.py --bump patch
```

Other version bumps:

```bash
npm run release:minor
npm run release:major
```

Press `F5` in VS Code to launch the Extension Development Host.
