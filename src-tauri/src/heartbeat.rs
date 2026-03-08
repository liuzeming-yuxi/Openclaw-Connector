use crate::health::{HealthStatus, HeartbeatSample};

#[derive(Debug, Clone)]
pub struct HeartbeatMonitor {
    failure_threshold: u32,
    consecutive_failures: u32,
    last_sample: Option<HeartbeatSample>,
}

impl HeartbeatMonitor {
    pub fn new(failure_threshold: u32) -> Self {
        Self {
            failure_threshold,
            consecutive_failures: 0,
            last_sample: None,
        }
    }

    pub fn record_sample(&mut self, sample: HeartbeatSample) {
        if sample.tunnel_connected && sample.gateway_ok {
            self.consecutive_failures = 0;
        } else {
            self.consecutive_failures += 1;
        }
        self.last_sample = Some(sample);
    }

    pub fn record_failure(&mut self) {
        self.consecutive_failures += 1;
    }

    pub fn status(&self) -> HealthStatus {
        if self.consecutive_failures >= self.failure_threshold {
            return HealthStatus::Offline;
        }

        match &self.last_sample {
            Some(sample) if sample.tunnel_connected && sample.gateway_ok => HealthStatus::Online,
            Some(_) => HealthStatus::Degraded,
            None => HealthStatus::Degraded,
        }
    }

    pub fn consecutive_failures(&self) -> u32 {
        self.consecutive_failures
    }

    pub fn last_sample(&self) -> Option<HeartbeatSample> {
        self.last_sample.clone()
    }
}
