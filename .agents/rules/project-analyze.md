---
trigger: always_on
---

# Global Project Context & Structure Rule

## Core Directive
You **MUST AUTOMATICALLY** locate and read the pre-compiled documentation inside the `graphify-out` directory whenever you need project context, folder structures, file dependencies, or architectural understanding. Do not wait for an explicit prompt to "analyze" the project; default to this directory first for any context gathering.

## Constraints & Prohibitions
- **DO NOT** manually crawl, list, or read source files one by one to figure out the project structure.
- **DO NOT** guess the architecture or file dependencies. Rely exclusively on the data provided in `graphify-out`.

## Agent Execution Steps
1. **Initialize Context:** At the start of any task requiring project-wide or folder-level awareness, immediately read the summary and structure files within the `graphify-out` directory.
2. **Acknowledge:** Base all your architectural reasoning, imports, and file path suggestions on the map provided in `graphify-out`.
3. **Targeted Deep Dives:** Only read specific, individual source code files (e.g., `.ts`, `.rs`, `.tsx`) when you need to edit them directly or inspect a specific function's implementation *after* you have already established the broader context from the `graphify-out` folder.