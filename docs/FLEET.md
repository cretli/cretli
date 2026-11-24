# Fleet

Fleet lets a hub owner register Cretli instances and see their health and a small set of operational counters in one panel.

## Register an instance

Open the Fleet tab and choose **Add instance**. Enter a display name such as `your-pc`, an optional owner label such as `acme`, the instance base URL, and its bearer token. The hub stores the token in its private fleet registry and sends it only to that registered instance when polling its `/mcp` endpoint. The token is write-only in the UI; edit the instance and enter a replacement token to rotate it.

Instance URLs must use HTTPS. HTTP is accepted only for loopback development stubs. URLs containing credentials, query strings, or fragments are rejected.

## Status and data

The hub polls the registered instance's `fleet_summary` MCP tool. A successful recent response appears online; an aging response appears stale; failed polling appears offline. Tiles show the last successful contact, active watcher cycles, blocked todos, plans awaiting approval, and provider usage and limit percentages. Remote free text and todo contents are not included in this summary.

Registry credentials are stored in the hub's runtime data directory with owner-only file permissions. Back up that directory using the same care as other Cretli secrets. Removing an instance deletes its registry entry and stops future polling.

## Example

Register `your-pc` at `https://your-pc.example.test` with owner label `acme`. The hub then polls it on the configured fleet schedule and displays its latest sanitized summary.
