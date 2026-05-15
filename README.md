# Yamakawa Code

A Claude Code–style chat sidebar for VS Code, powered by any OpenAI-compatible endpoint.

## Features

- Sidebar chat view with a refined, Claude-inspired UI.
- Streaming responses with a smooth typewriter effect.
- Markdown rendering (headings, lists, code blocks, inline code, links).
- Per-workspace conversation history with one-click clear.
- Configurable base URL, model, system prompt, and temperature.
- API key resolved from `yamakawaCode.apiKey`, then `OPENAI_API_KEY`, then `OHMYGPT_API_KEY`.

## Defaults

- Endpoint: `https://apic1.ohmycdn.com/v1/chat/completions`
- Model: `gpt-5.2`

## Configuration

Open Settings and search for **Yamakawa Code** to customize:

- `yamakawaCode.baseUrl`
- `yamakawaCode.model`
- `yamakawaCode.apiKey`
- `yamakawaCode.systemPrompt`
- `yamakawaCode.temperature`

## Development

```bash
npm install
npm run compile
```

## Release

Set Marketplace token first:

```bash
export VSCE_PAT=your_marketplace_pat
```

Then use one command:

```bash
npm run release:patch
```

Other version bumps:

```bash
npm run release:minor
npm run release:major
```

Press `F5` in VS Code to launch the Extension Development Host.
