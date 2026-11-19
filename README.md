# Virtual Presentation Academy (SaleLabs training)

Static course + presentation tool, with two Netlify functions:

- `/api/claude` – AI family brain and grading (env: `ANTHROPIC_API_KEY`, optional `MODEL_FAST`, `MODEL_SMART`)
- `/api/anam/session`, `/api/anam/catalog` – video avatars (env: `ANAM_API_KEY`)

Optional env: `ALLOWED_ORIGINS` (comma-separated extra origins allowed to call the functions).

Casting page: open the site with `#cast` at the end of the address.
