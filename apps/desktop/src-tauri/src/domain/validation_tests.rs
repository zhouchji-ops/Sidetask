use super::*;
use serde_json::json;

fn create(date: &str, time: Option<&str>, zone: &str) -> Result<Snapshot, String> {
    Snapshot::empty().apply(Action::CreateTask {
        task: json!({ "title": "时间测试", "notes": "", "priority": "normal", "dueDate": date, "dueTime": time, "dueTimezone": zone, "addToToday": false }),
        date: "2026-09-24".into(),
    }, 1)
}
#[test]
fn strict_dates_reject_normalized_or_out_of_contract_values() {
    for date in [
        "2026-02-30",
        "2026-2-03",
        "0000-01-01",
        "2026-01-01 ",
        "2026-00-01",
        "+026-01-01",
    ] {
        assert!(deadline::valid_date(date).is_err(), "{date}");
    }
    assert!(deadline::valid_date("2028-02-29").is_ok());
    assert!(deadline::valid_date("0001-01-01").is_ok());
}
#[test]
fn precise_deadlines_store_fixed_utc_and_reject_both_dst_hazards() {
    let snapshot = create("2026-09-24", Some("18:30"), "Asia/Shanghai").unwrap();
    assert_eq!(
        snapshot.tasks[0].due_at_utc.as_deref(),
        Some("2026-09-24T10:30:00Z")
    );
    assert!(create("2026-03-08", Some("02:30"), "America/New_York")
        .unwrap_err()
        .contains("不存在"));
    assert!(create("2026-11-01", Some("01:30"), "America/New_York")
        .unwrap_err()
        .contains("两次"));
    assert!(create("2026-09-24", Some("18:30"), "+08:00").is_err());
}
#[test]
fn date_boundaries_use_calendar_days_including_dst_and_midnight_gaps() {
    for (date, zone, expected) in [
        ("2026-03-08", "America/New_York", "2026-03-09T04:00:00Z"),
        ("2026-11-01", "America/New_York", "2026-11-02T05:00:00Z"),
        ("2018-11-03", "America/Sao_Paulo", "2018-11-04T03:00:00Z"),
        ("2011-12-29", "Pacific/Apia", "2011-12-30T10:00:00Z"),
    ] {
        let snapshot = create(date, None, zone).unwrap();
        assert!(snapshot.tasks[0].due_at_utc.is_none());
        assert_eq!(
            deadline::date_only_boundary(date, zone).unwrap(),
            deadline::parse_utc(expected).unwrap()
        );
    }
    assert!(create("2011-12-30", None, "Pacific/Apia")
        .unwrap_err()
        .contains("不存在"));
}
#[test]
fn reading_and_non_deadline_edits_never_reinterpret_legacy_deadlines() {
    let initial = Snapshot::demo("2026-09-24");
    let before = serde_json::to_value(&initial).unwrap();
    initial.validate().unwrap();
    assert_eq!(before, serde_json::to_value(&initial).unwrap());
    let task = &initial.tasks[0];
    let renamed = initial.apply(Action::UpdateTask {
        id: task.id.clone(), expected_revision: task.revision,
        changes: json!({"title":"新标题", "dueDate":task.due_date, "dueTime": task.due_time}),
    }, initial.revision).unwrap();
    assert!(renamed.tasks[0].due_timezone.is_none());
    assert!(renamed.tasks[0].due_at_utc.is_none());
    let changed = renamed
        .apply(
            Action::UpdateTask {
                id: task.id.clone(),
                expected_revision: renamed.tasks[0].revision,
                changes: json!({"dueTime":"19:00", "dueTimezone":"Asia/Shanghai"}),
            },
            renamed.revision,
        )
        .unwrap();
    assert_eq!(
        changed.tasks[0].due_at_utc.as_deref(),
        Some("2026-09-25T11:00:00Z")
    );
    let cleared = changed
        .apply(
            Action::UpdateTask {
                id: task.id.clone(),
                expected_revision: changed.tasks[0].revision,
                changes: json!({"dueDate":null,"dueTime":null}),
            },
            changed.revision,
        )
        .unwrap();
    assert!(cleared.tasks[0].due_timezone.is_none());
    assert!(cleared.tasks[0].due_at_utc.is_none());
}
#[test]
fn committed_utc_is_not_recomputed_during_read_or_title_edits() {
    let mut initial = create("2026-09-24", Some("18:30"), "Asia/Shanghai").unwrap();
    // A changed tzdb rule must not rewrite a previously committed instant.
    initial.tasks[0].due_at_utc = Some("2026-09-24T11:30:00Z".into());
    initial.validate().unwrap();
    let next = initial
        .apply(
            Action::UpdateTask {
                id: initial.tasks[0].id.clone(),
                expected_revision: 1,
                changes: json!({"title":"只改备注以外字段"}),
            },
            initial.revision,
        )
        .unwrap();
    assert_eq!(next.tasks[0].due_at_utc, initial.tasks[0].due_at_utc);
}
#[test]
fn snapshot_validation_rejects_relational_and_revision_corruption() {
    let initial = Snapshot::demo("2026-09-24");
    let mut duplicate = initial.clone();
    duplicate.tasks.push(initial.tasks[0].clone());
    assert!(duplicate.validate().is_err());
    let mut dangling = initial.clone();
    dangling.plans[0].task_id = "absent".into();
    assert!(dangling.validate().is_err());
    let mut duplicate_plan = initial.clone();
    duplicate_plan.plans.push(initial.plans[0].clone());
    assert!(duplicate_plan.validate().is_err());
    let mut invalid_date = initial.clone();
    invalid_date.plans[0].date = "2026-02-30".into();
    assert!(invalid_date.validate().is_err());
    let mut revision = initial.clone();
    revision.tasks[0].revision = 2;
    assert!(revision.validate().is_err());
    revision.revision = MAX_SAFE_REVISION + 1;
    assert!(revision.validate().is_err());
    let mut completion = initial.clone();
    completion.tasks[0].completed_at = Some(initial.tasks[0].created_at.clone());
    assert!(completion.validate().is_err());
    let mut utc = initial.clone();
    utc.tasks[0].created_at = "2026-09-24T18:00:00+08:00".into();
    assert!(utc.validate().is_err());
    let mut missing_instant = create("2026-09-24", Some("18:30"), "Asia/Shanghai").unwrap();
    missing_instant.tasks[0].due_at_utc = None;
    assert!(missing_instant.validate().is_err());
}
#[test]
fn unknown_fields_and_malformed_boolean_are_rejected_without_writes() {
    let initial = Snapshot::empty();
    let before = serde_json::to_value(&initial).unwrap();
    for task in [
        json!({"title":"正常", "parentId":"不应接受", "addToToday": false}),
        json!({"title":"正常", "addToToday":"false"}),
        json!({"title":"正常", "addToToday":null}),
        json!({"title":"正常", "addToToday":false,"dueAtUtc":"2026-09-24T10:00:00Z"}),
    ] {
        assert!(initial
            .apply(
                Action::CreateTask {
                    task,
                    date: "2026-09-24".into()
                },
                initial.revision
            )
            .is_err());
        assert_eq!(before, serde_json::to_value(&initial).unwrap());
    }
    let mut unknown = serde_json::to_value(Snapshot::demo("2026-09-24")).unwrap();
    unknown["tasks"][0]["parentId"] = json!("unexpected");
    assert!(serde_json::from_value::<Snapshot>(unknown).is_err());
}
#[test]
fn empty_snapshot_is_valid_and_overflow_is_rejected_without_panicking() {
    let mut snapshot = Snapshot::empty();
    snapshot.validate().unwrap();
    assert!(snapshot.tasks.is_empty());
    snapshot.revision = MAX_SAFE_REVISION;
    let before = serde_json::to_value(&snapshot).unwrap();
    assert!(snapshot
        .apply(
            Action::UpdateSettings {
                changes: json!({"theme":"dark"})
            },
            snapshot.revision
        )
        .unwrap_err()
        .contains("安全范围"));
    assert_eq!(before, serde_json::to_value(&snapshot).unwrap());
}

#[test]
fn utc_parser_matches_the_frontend_contract_and_rejects_silent_truncation() {
    for at in [
        "2026-09-24T00:00:00Z",
        "2026-09-24T00:00:00.123456789Z",
        "2026-09-24T00:00:00+00:00",
    ] {
        assert!(deadline::parse_utc(at).is_ok(), "{at}");
    }
    for at in [
        "2026-09-24t00:00:00Z",
        "2026-09-24T00:00:00z",
        "2026-09-24T00:00:60Z",
        "2026-09-24T00:00:00.1234567891Z",
        "0000-09-24T00:00:00Z",
        "2026-02-30T00:00:00Z",
    ] {
        assert!(deadline::parse_utc(at).is_err(), "{at}");
    }
}
