---
title: Remote access, PWA and notifications
description: Open Cretli from a phone or another computer safely, and understand the defaults.
---

# Remote access, PWA and notifications

Cretli listens on `127.0.0.1` by default, so only the machine it runs on can reach it. Everything below is opt-in.

## Enable LAN access

To use a phone or another computer on a trusted network, set a setup token and start the LAN script:

```bash
export CRETLI_SETUP_TOKEN="$(openssl rand -hex 16)"
npm run start:lan
```

Set `CRETLI_LAN_HOST` to the address other devices will use, then open `https://<that address>:3011`. `CRETLI_BIND` accepts one address or a comma-separated list, for example `127.0.0.1,192.0.2.10`. As soon as any non-local address is bound, Cretli requires a password or the setup token. Allow the Node binary through your firewall when prompted. On WSL, LAN access needs the Windows LAN address and a forward from Windows; see [troubleshooting](troubleshooting.md).

## HTTPS and the PWA

Cretli serves HTTPS with a self-signed certificate by default, so a browser shows a warning once per device. For a trusted certificate on your network, follow the trusted HTTPS guide in the repository. Browsers install a progressive web app and deliver push messages only from a trusted HTTPS origin. After installing, the app opens in its own window and shows an update banner when new assets are ready.

## Notifications

Cretli can send web push notifications, for example when the Watcher finds waiting work or a task is blocked. They need a trusted HTTPS origin and your permission in the browser. Notifications are best effort and never replace checking the task.

## Expose a port

An agent can ask Cretli to open a development port to your LAN with `port_expose`. With the default policy (`agentMode` set to `ask`) you approve each request in a consent card in the chat. With `allow_in_range` the port is exposed without a card, and with `never` every request is refused. Cretli also refuses debug and similar ports, ports outside its range, and apps listening only on loopback. Check with `port_status` before sharing a link.

## Security notes

Cretli provides a full shell. Do not forward it to the internet. Read [security basics](security-basics.md) before enabling remote access.

<!-- sources: docs/INSTALL.md, docs/apps-and-ports.md, docs/trusted-https.md, SECURITY.md -->
