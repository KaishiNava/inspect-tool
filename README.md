# FX Web Inspector

Railway-ready web inspector built with Express, Playwright and WebSocket.

## Features

- Live Network request/response monitor
- HTTP method, status, resource type, URL, size and timing
- Request/response headers
- Request body
- Text/JSON response preview
- Browser console capture
- HTML/DOM snapshot
- LocalStorage, SessionStorage and cookies viewer
- Page metadata
- Search/filter
- Copy captured Network JSON
- Responsive dark UI
- Docker/Railway deployment
- Basic SSRF protection for private/local targets

## Deploy to Railway

1. Push this folder to GitHub.
2. Create a new Railway project.

The included Dockerfile uses `npm install --omit=dev`, so a package-lock.json is not required for the initial Railway deployment.
3. Deploy the GitHub repository.
4. Railway will detect the Dockerfile.
5. Wait for Chromium dependencies to install.
6. Open the generated Railway domain.
7. Enter a public `https://` or `http://` URL.
8. Press Inspect.

No PORT needs to be configured manually; the app uses Railway's `PORT`.

## Local

```bash
npm install
npx playwright install --with-deps chromium
npm start
```

Open `http://localhost:3000`.

## Notes

This is a remote browser inspector, not a replacement for Chrome's privileged DevTools protocol attached to your own Android/desktop browser. It inspects pages loaded by the Railway-hosted Chromium session.

Only inspect websites you are authorized to test. The server blocks obvious localhost/private IP targets to reduce SSRF risk.
