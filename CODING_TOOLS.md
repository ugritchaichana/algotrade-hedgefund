# AI Coding Tools Support Guide

This repository is fully optimized to be developed, maintained, and refactored by mainstream AI Coding Assistants. We have provided context files that your AI agents will automatically pick up to understand the boundaries and logic of the HedgeFund AI System.

## Supported AI Tools
- **Mimo Claw (Xiaomi):** Supported via `MIMO.md`. Custom logic rules included for `mimo-v2.5` vs `mimo-v2.5-pro`.
- **Claude Code (Anthropic):** Supported via `CLAUDE.md`.
- **Cursor / OpenCode:** Supported via `.cursorrules`.
- **OpenClaw / KiloCode / Generic Agents:** Supported via `.ai-context.md`.

## How it works
When you open this repository in an AI-powered IDE (like Cursor) or run a CLI agent (like Claude Code or OpenClaw), the agent will automatically read the root configuration files. 

These files enforce **Strict Development Boundaries**:
1. **Safety First:** The AI is instructed *never* to bypass the MT5 Spread Protection or the 1000ms Ping Latency checks.
2. **Dynamic Configuration:** The AI is instructed *never* to hardcode trading pairs or API keys, ensuring that your code remains clean and ready for open-source release.
3. **Architecture Adherence:** The AI is taught about the 3-Desk system (Quant, Macro, Risk) so it knows exactly where to place new logic without breaking the Microservices structure.

## Modifying Guidelines
If you want to change the rules for future AI agents (e.g., you want the AI to start using a different LLM model, or change the risk percentage):
1. Edit `.ai-context.md` (for generic agents).
2. Edit `CLAUDE.md` and `.cursorrules` (for specific IDEs).

The AI will adapt to your new rules on its next execution.
