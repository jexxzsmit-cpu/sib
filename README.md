# CatHub Codex

A local terminal coding assistant for GitHub projects. It can inspect project files, review Git changes, run the project's npm tests, make approved file edits, and create approved pull requests through the GitHub CLI.

## Requirements

- Node.js 20 or newer
- An OpenAI API key
- Git; GitHub CLI (`gh`) is needed only to create pull requests

## Start

```bash
npm install
export OPENAI_API_KEY="your-api-key"
npm run dev
```

Set `OPENAI_MODEL` to use another model available to your API account. The default is `gpt-4.1-mini`.

Type `/exit` to close the assistant. It uses the current directory as the project root.

## Safety

- File reads and directory listings are limited to the project root; symbolic links are not followed.
- `.env` files and files with names suggesting secrets or private keys are blocked from assistant access.
- The assistant must ask before it writes a file, runs `npm test`, or creates a GitHub pull request.
- Tests run only through the project's `npm test` script. Pull requests use the authenticated `gh` CLI.
- Do not use this assistant with untrusted projects or prompts unless you review the proposed actions.

Build the compiled CLI with `npm run build`, then run it with `npm start`.
