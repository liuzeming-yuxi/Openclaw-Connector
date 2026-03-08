use connector::heartbeat::HeartbeatMonitor;
use connector::health::HealthStatus;

#[test]
fn marks_offline_after_consecutive_failures() {
    let mut hb = HeartbeatMonitor::new(3);
    hb.record_failure();
    hb.record_failure();
    hb.record_failure();
    assert_eq!(hb.status(), HealthStatus::Offline);
}
