# Embedding a widget

Use the installation snippet from **Settings → Widgets**. It loads the bundle asynchronously, so an unavailable widget host does not hold up the host page's parser:

```html
<script async src="https://your-cretli-host.example/dist/app/embed-widget.bundle.js" data-installation-id="YOUR_INSTALLATION_ID"></script>
```

The URL must be reachable from every visitor's browser. A local or private network address only works for devices that can reach that network; do not hardcode a LAN address into a public page. Use a stable hostname and configure HTTPS when the host page uses HTTPS.

For pages that need to decide at runtime whether to load the widget, inject the script dynamically:

```html
<script>
  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://your-cretli-host.example/dist/app/embed-widget.bundle.js';
  script.dataset.installationId = 'YOUR_INSTALLATION_ID';
  document.head.append(script);
</script>
```
