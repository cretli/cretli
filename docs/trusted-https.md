# Trusted HTTPS with local DNS

Accepting a self-signed certificate warning can allow the page to load while the
browser still refuses to register `/sw.js`. Service workers, offline caching and
push notifications need HTTPS that the browser trusts.

Use a domain you control, for example `cretli.example.com`, and a certificate
covering that exact hostname. A certificate for another application hostname
does not cover Cretli unless its subject alternative names or wildcard include
the new name.

## Local DNS and certificate issuance

1. Add a local DNS record on your gateway pointing the chosen hostname to the
   Cretli machine. Clients must use a resolver that serves that local record.
   UniFi supports [local DNS records](https://help.ui.com/hc/en-us/articles/15179064940439-UniFi-DNS-Records-and-Local-Hostnames).
2. Obtain a certificate from a trusted certificate authority. For a service that
   stays inside the LAN, [Let's Encrypt DNS-01](https://letsencrypt.org/docs/challenge-types/#dns-01-challenge)
   validates domain ownership through a public TXT record without exposing the
   application to the Internet. DNS hosting and certificate issuance are separate.
3. If the authoritative DNS zone is hosted at OVH, Certbot's
   [dns-ovh plugin](https://certbot-dns-ovh.readthedocs.io/en/stable/)
   can automate validation and renewal. Keep API credentials outside the repository
   and limit their permissions to the required zone.

## Use the certificate in Cretli

Configure the process that starts Cretli with these values, using the actual
hostname and certificate paths:

```dotenv
USE_HTTPS=1
SSL_KEY_PATH=/etc/cretli/tls/privkey.pem
SSL_CERT_PATH=/etc/cretli/tls/fullchain.pem
CRETLI_PUBLIC_ORIGIN=https://cretli.example.com:3011
```

The Cretli process must be able to read the private key and full certificate chain.
Keep private keys out of Git. Changing certificate paths requires restarting the
process. For renewals at the same paths, Settings → Connection → HTTPS certificates
can apply updated files without restarting the server. Include deployment and
application of renewed certificates in the renewal procedure.

Open the application using its domain name, including `:3011` when connecting
directly. Access through a LAN IP still requires a certificate covering that IP.
Verify that the browser reports a trusted connection and that `/sw.js` registers
successfully in DevTools → Application → Service Workers.

An existing reverse proxy can terminate TLS instead. Configure WebSocket
forwarding and `CRETLI_PUBLIC_ORIGIN` as described in [INSTALL.md](INSTALL.md).
