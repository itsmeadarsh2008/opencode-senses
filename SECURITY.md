# Security Policy

OpenCode Senses is a **local-first** vision plugin. Images and analysis never leave your machine unless you explicitly opt into a remote provider (`senses_reverse` with `yandex`, or Moondream hosted finetunes via `MOONDREAM_API_KEY`).

## Supported versions

| Version | Supported |
|---|---|
| Latest npm release | Yes |
| `main` branch | Yes (best effort) |
| Older releases | No |

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Report privately instead:

- **Email**: reach out via a [private security advisory](https://github.com/itsmeadarsh2008/opencode-senses/security/advisories/new)
- **GitHub**: use the "Report a vulnerability" button on the repository's Security tab

Please include, where possible:

1. A description of the vulnerability and its impact
2. Steps to reproduce (minimal, please)
3. Affected versions and configurations
4. Suggested fix, if you have one

You will receive a response within 7 days, and we will work with you on a coordinated disclosure. If you found a real issue, you also have our genuine thanks and a place in the release notes (if you want one).

## Security-relevant areas

Things we consider in-scope for security review:

- **Prompt injection**: any new code path that lets image-derived text reach the model outside the `<SENSES>` untrusted-data guards
- **Remote fetch**: `path` accepting `http(s)://` URLs — SSRF considerations, size/timeout handling, file-type verification
- **Path handling**: materialized files in `/tmp`, crops/zooms/annotations in the cache dir, reverse-search index — no path traversal, no symlink tricks
- **Runtime provisioning**: the auto-installed Python venv and model weight downloads are checksum-less third-party artifacts; treat supply-chain risk seriously
- **Local-only guarantee**: no hidden telemetry, no background uploads, ever

## Non-issues

- Bugs, crashes, or poor OCR quality are normal issues, not vulnerabilities. Open them as regular issues.
- The vision model being imperfect at reading text is a feature request, not a breach. It is, after all, a small model with big feelings.