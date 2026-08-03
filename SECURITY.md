# Security

## Secrets

| Store | Location | In git? |
|-------|----------|---------|
| Grok OAuth | `~/.grok/auth.json` | **Never** |
| Codex OAuth | `~/.codex/auth.json` | **Never** |
| Grok API key | Zotero prefs (`grokApiKey`) | **Never** (local profile only) |
| Embed API key | Zotero prefs | **Never** |
| GitHub token | CI `GITHUB_TOKEN` / local env | **Never** commit |

- Do not log access/refresh tokens or full API keys (`diag` must not include them).
- Prefs password fields: use `type="password"` in `preferences.xhtml`.
- Diagnostic clipboard report: env + ring buffer only — no auth file contents.

## Network

- LLM calls go to configured base URL (default `https://api.x.ai/v1`) or Codex.
- Paper text / selection / images leave the machine only when the user runs translate/explain/chat/figure.
- RAG indexes and stickies stay under `~/.paperai/` on disk.

## Reporting

If you find a vulnerability in this plugin, open a private security advisory on the GitHub repo or contact the maintainer — do not file a public issue with exploit details.
