# my-diary-repo

## AI provider setup

Set these build environment variables in GitHub Actions or your hosting provider:

- `VITE_GROQ_API_KEY`: required for persistent diary indexing and AI Cognitive Brain search.
- `VITE_GEMINI_API_KEY`: optional for lighter AI tasks such as writing prompts and topic tags.
- `VITE_GROQ_MODEL`: optional override, defaults to `llama-3.1-8b-instant`.
- `VITE_GEMINI_MODEL`: optional override, defaults to `gemini-1.5-flash`.

The encrypted vault is encoded and decoded with byte-safe UTF-8 helpers before GitHub upload/download. Do not replace these with direct `btoa(text)` or `atob(text)` calls, because that causes corrupted characters such as `â€¦`.
