---
"@armyofagents/server": patch
---

Deprecate the server-side OpenAI Whisper transcription path. POST /companies/:cid/transcribe now returns 501 with a documented body pending the Commander sub-agent migration (Decision #91). Removes the silent `process.env.OPENAI_API_KEY` fallback that could bill the host operator for tenant audio. UI degrades to a "voice input not yet available" state with Paste/Write controls intact.
