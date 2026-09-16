# books-files

Small companion service for books-agent (a book-request page for Chaptarr)
that runs next to Chaptarr. It serves finished ebook files and converts them to
**EPUB**, **AZW3** or **MOBI** with Calibre's `ebook-convert`, so people can
download a book to their phone, computer or Kindle from the books page.

It only ever reads the library (mounted read-only). Converted copies go to a
cache folder and are removed after 14 days without use.

## API

Every endpoint except `/healthz` needs `Authorization: Bearer $FILES_TOKEN`.
Paths are relative to the ebook library root (`/ebooks` in the container).

| Endpoint | Description |
|---|---|
| `POST /v1/prepare` `{"path", "format"}` | `format` is `original`, `epub`, `azw3` or `mobi`. Returns `{"state": "ready" \| "converting" \| "failed", "error"?}` and starts a conversion when needed. Poll it until `ready`. |
| `GET /v1/file?path=&format=` | Streams the original or a finished conversion; `409` if the conversion isn't ready. The `X-File-Extension` header gives the extension. |
| `GET /healthz` | Liveness, no auth. |

Paths that resolve outside the library (including through symlinks) and
non-ebook files are refused. Conversions run at most `MAX_CONVERSIONS` at a
time (default 2) with a 10-minute limit; DRM-protected books can be
downloaded in their original format but can't be converted.

## Deploy (Dockge on the Chaptarr host)

Create a stack named `books-files` from [`compose.yaml`](compose.yaml), point
the two volume paths at Chaptarr's ebook folder and an appdata folder, and add
a `.env` with `FILES_TOKEN` (`openssl rand -hex 32`). Set the same token as
`FILES_TOKEN` in books-agent's `.env`, with `FILES_URL` pointing at this host
on port 8790.

Pushing to `main` runs the tests and publishes
`ghcr.io/zchesler/books-files:latest`; Watchtower on the host picks it up.
