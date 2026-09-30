# Security Policy

Thank you for helping keep Army of Agents safe. Please do not report security vulnerabilities through public GitHub issues.

## Supported versions

Until the project has tagged stable releases, security fixes target the `main` branch and the latest published release, if one exists.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting flow for this repository when available:

- Open the repository on GitHub.
- Go to **Security**.
- Choose **Report a vulnerability**.

If private vulnerability reporting is not available for you, open a minimal public issue that says you need a private security contact. Do not include exploit details, secrets, logs, tokens, customer data, or reproduction steps in that public issue.

## Sensitive areas

Please use the private reporting path for issues involving:

- authentication, sessions, invites, or API keys
- company or tenant boundary bypasses
- agent execution, adapters, workspaces, or shell/process execution
- secrets storage or environment variable leakage
- marketplace catalog, plugin, skill, or connector trust boundaries
- MCP tools, Commander tools, or governed action approval bypasses
- SSRF, RCE, XSS, path traversal, or unsafe file serving
- budget, approval, or audit-log bypasses

## Safe testing expectations

When testing security behavior:

- Use your own local instance or a repository you control.
- Do not test against systems you do not own or administer.
- Do not access, modify, or exfiltrate another user's data.
- Do not publish exploit details before a fix is available.
- Keep proof-of-concept payloads minimal and focused on demonstrating the issue.

## What to include

A helpful private report includes:

- affected version, branch, or commit
- deployment mode and relevant configuration
- reproduction steps
- expected and actual behavior
- impact and affected trust boundary
- logs or screenshots with secrets removed
- whether the issue is already public anywhere else

We aim to acknowledge reports as quickly as possible and will coordinate disclosure timing with reporters when practical.
