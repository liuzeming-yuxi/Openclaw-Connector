use connector::executor::TaskExecutor;
use connector::tasks::IncomingTask;

#[test]
fn executes_system_run_action() {
    let exec = TaskExecutor::new();
    let task = IncomingTask {
        task_id: "t-2".to_string(),
        agent_id: "main".to_string(),
        action: "system.run".to_string(),
        args: serde_json::json!({"command": "printf ok"}),
        timeout_sec: 5,
    };

    let out = exec.execute(&task).expect("exec success");
    assert_eq!(out.exit_code, 0);
    assert_eq!(out.stdout, "ok");
}
