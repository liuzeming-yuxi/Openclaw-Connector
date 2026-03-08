use connector::config::AppConfig;
use connector::ssh_tunnel::{TunnelManager, TunnelState};

fn sample_cfg() -> AppConfig {
    let mut cfg = AppConfig::default();
    cfg.server.user = "tester".to_string();
    cfg.server.key_path = "/tmp/fake_key".to_string();
    cfg
}

#[test]
fn starts_and_stops_tunnel() {
    std::env::set_var("OPENCLAW_CONNECTOR_FAKE_TUNNEL", "1");
    let mut mgr = TunnelManager::new();
    assert!(mgr.start(sample_cfg().server).is_ok());
    assert_eq!(mgr.state(), TunnelState::Connected);
    assert!(mgr.stop().is_ok());
    assert_eq!(mgr.state(), TunnelState::Disconnected);
    std::env::remove_var("OPENCLAW_CONNECTOR_FAKE_TUNNEL");
}
