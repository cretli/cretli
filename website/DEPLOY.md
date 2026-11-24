# Publishing the static site

Run `npm ci`, `npm run docs:build`, and `npm run docs:check` from the repository root. Upload the entire `website/` folder to a static host. There is no server runtime or third-party asset service.

The canonical origin is https://cretli.com. Configure that custom domain and HTTPS at the host, then configure its recommended DNS records with your DNS provider. Serve `index.html` for directory requests, preserve `/docs/en/`, `/docs/pl/`, `/pl/`, and `/docs/img/`, and serve `/sitemap.xml` from the root. English is the default language.

`deploy/pages.yml.example` is an inert GitHub Pages template. Review the branch, permissions, environment and custom domain before manually placing it in `.github/workflows/`. Enable Pages with GitHub Actions in repository settings only when ready to publish. No workflow is enabled by this change.

Preview a build locally with any static file server rooted at `website/`. Publishing and DNS changes require a separate operator action. A deployment publishes only the product site; never deploy the Cretli runtime or its private runtime files as static content.
