# Operations Runbook

## Connection States

- `online`: tunnel connected and gateway health check successful.
- `degraded`: partial connectivity or transient failures.
- `offline`: repeated failures beyond threshold.

## Emergency Disconnect

1. Open `Danger Zone`.
2. Click `Emergency Disconnect`.
3. Verify tunnel status is `disconnected`.
4. Verify task loop is no longer active.

## SSH Diagnostics

- Confirm host/user/key path values in `Connection`.
- Confirm local and remote ports match gateway configuration.
- Use `get_tunnel_status` command output for state and last error.
