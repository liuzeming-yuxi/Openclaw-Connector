# Troubleshooting

## Cannot Connect

- Ensure Linux gateway is running and bound to loopback.
- Validate SSH key permissions and account access.
- Check whether local forward ports are already occupied.

## Heartbeat Stays Offline

- Verify tunnel is connected before heartbeat polling.
- Verify gateway `/health` endpoint responds with HTTP 200.
- Inspect consecutive failure count in the health store.

## Task Not Executing

- Verify agent is bound to the local node ID.
- Verify task action is `system.run`.
- Check callback payload for non-zero exit codes.
