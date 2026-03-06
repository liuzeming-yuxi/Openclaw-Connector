use connector::heartbeat::HeartbeatMonitor;
use connector::ssh_tunnel::TunnelManager;

#[test]
fn health_summary_reflects_tunnel_state() {
    std::env::set_var("OPENCLAW_CONNECTOR_FAKE_TUNNEL", "1");

    let mut tunnel = TunnelManager::new();
    let monitor = HeartbeatMonitor::new(3);

    // Before connecting: tunnel disconnected
    let connected = tunnel.is_connected();
    assert!(!connected);
    assert_eq!(monitor.consecutive_failures(), 0);

    // After connecting: tunnel connected
    let cfg = connector::config::AppConfig::default();
    let mut server = cfg.server;
    server.user = "tester".to_string();
    server.key_path = "/tmp/fake_key".to_string();
    tunnel.start(server).unwrap();
    assert!(tunnel.is_connected());

    // After stop: tunnel disconnected
    tunnel.stop().unwrap();
    assert!(!tunnel.is_connected());

    std::env::remove_var("OPENCLAW_CONNECTOR_FAKE_TUNNEL");
}
