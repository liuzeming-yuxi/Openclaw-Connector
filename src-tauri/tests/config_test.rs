use connector::config::{load_config, save_config, AppConfig};

#[test]
fn loads_and_saves_single_server_config() {
    let base = std::env::temp_dir().join(format!(
        "connector-config-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("unix time")
            .as_nanos()
    ));
    std::fs::create_dir_all(&base).expect("create temp dir");

    let path = base.join("config.json");
    let cfg = AppConfig::default();
    save_config(&path, &cfg).expect("save config");

    let loaded = load_config(&path).expect("load config");
    assert_eq!(loaded.server.host, cfg.server.host);
    assert_eq!(loaded.server.local_port, cfg.server.local_port);

    std::fs::remove_dir_all(base).expect("cleanup");
}
