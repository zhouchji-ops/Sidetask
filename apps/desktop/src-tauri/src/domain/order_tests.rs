use super::*;

fn eligible(snapshot: &Snapshot, scope: &str) -> Vec<String> {
    snapshot
        .tasks
        .iter()
        .filter(|task| {
            !task.completed
                && task.deleted_at.is_none()
                && (scope == "all" || task.due_date.is_some())
        })
        .map(|task| task.id.clone())
        .collect()
}

#[test]
fn independent_orders_preserve_task_records_and_daily_plans() {
    let initial = Snapshot::demo("2026-09-28");
    let mut all_ids = eligible(&initial, "all");
    all_ids.reverse();
    let all = initial
        .apply(
            Action::ReorderTasks {
                scope: "all".into(),
                task_ids: all_ids.clone(),
            },
            initial.revision,
        )
        .unwrap();
    let mut ddl_ids = eligible(&initial, "deadlines");
    ddl_ids.reverse();
    let ddl = all
        .apply(
            Action::ReorderTasks {
                scope: "deadlines".into(),
                task_ids: ddl_ids.clone(),
            },
            all.revision,
        )
        .unwrap();
    assert_eq!(ddl.task_order, all_ids);
    assert_eq!(ddl.deadline_order, ddl_ids);
    assert_eq!(ddl.settings.ddl_sort, "manual");
    assert_eq!(ddl.tasks, initial.tasks);
    assert_eq!(
        serde_json::to_value(&ddl.plans).unwrap(),
        serde_json::to_value(&initial.plans).unwrap()
    );
    assert_eq!(ddl.revision, initial.revision + 2);
    assert_eq!(all.settings.ddl_sort, "date");
    let decoded: Snapshot = serde_json::from_str(&serde_json::to_string(&ddl).unwrap()).unwrap();
    assert_eq!(decoded.task_order, ddl.task_order);
    assert_eq!(decoded.deadline_order, ddl.deadline_order);
}

#[test]
fn reordering_preserves_inactive_slots_and_appends_unranked_tasks() {
    let mut initial = Snapshot::demo("2026-09-28");
    let ids: Vec<_> = initial.tasks.iter().map(|task| task.id.clone()).collect();
    initial.task_order = ids.clone();
    initial.tasks[0].deleted_at = Some("2026-09-28T01:00:00Z".into());
    let mut requested = eligible(&initial, "all");
    requested.reverse();
    let changed = initial
        .apply(
            Action::ReorderTasks {
                scope: "all".into(),
                task_ids: requested.clone(),
            },
            initial.revision,
        )
        .unwrap();
    assert_eq!(changed.task_order[0], ids[0]);
    assert_eq!(changed.task_order[3], ids[3]);
    let active: Vec<_> = changed
        .task_order
        .iter()
        .filter(|id| requested.contains(id))
        .cloned()
        .collect();
    assert_eq!(active, requested);
    assert_eq!(changed.tasks, initial.tasks);
    let restored = changed
        .apply(
            Action::RestoreTask {
                id: ids[0].clone(),
                expected_revision: 1,
            },
            changed.revision,
        )
        .unwrap();
    assert_eq!(restored.task_order, changed.task_order);
    let mut partial = initial.clone();
    partial.task_order = vec![ids[0].clone(), requested[1].clone()];
    let appended = partial
        .apply(
            Action::ReorderTasks {
                scope: "all".into(),
                task_ids: requested.clone(),
            },
            partial.revision,
        )
        .unwrap();
    assert_eq!(
        appended.task_order,
        std::iter::once(ids[0].clone())
            .chain(requested)
            .collect::<Vec<_>>()
    );
}

#[test]
fn reorder_rejects_invalid_membership_unknown_scope_and_stale_snapshot() {
    let initial = Snapshot::demo("2026-09-28");
    let before = serde_json::to_value(&initial).unwrap();
    for scope in ["all", "deadlines"] {
        let ids = eligible(&initial, scope);
        let mut duplicate = ids.clone();
        duplicate[0] = duplicate[1].clone();
        let mut missing = ids.clone();
        missing[0] = "unknown-task".into();
        let mut completed = ids.clone();
        completed[0] = initial.tasks[3].id.clone();
        for task_ids in [ids[1..].to_vec(), duplicate, missing, completed] {
            assert!(initial
                .apply(
                    Action::ReorderTasks {
                        scope: scope.into(),
                        task_ids
                    },
                    initial.revision
                )
                .is_err());
        }
        assert!(initial
            .apply(
                Action::ReorderTasks {
                    scope: scope.into(),
                    task_ids: ids
                },
                initial.revision + 1
            )
            .is_err());
    }
    assert!(initial
        .apply(
            Action::ReorderTasks {
                scope: "trash".into(),
                task_ids: vec![]
            },
            initial.revision
        )
        .is_err());
    assert_eq!(serde_json::to_value(&initial).unwrap(), before);
}

#[test]
fn legacy_orders_default_empty_but_bad_references_duplicates_and_null_are_rejected() {
    let initial = Snapshot::demo("2026-09-28");
    let mut value = serde_json::to_value(&initial).unwrap();
    assert!(value.get("taskOrder").is_none());
    assert!(value.get("deadlineOrder").is_none());
    let decoded: Snapshot = serde_json::from_value(value.clone()).unwrap();
    assert!(decoded.task_order.is_empty() && decoded.deadline_order.is_empty());
    for key in ["taskOrder", "deadlineOrder"] {
        for ids in [
            serde_json::json!(["missing"]),
            serde_json::json!([initial.tasks[0].id, initial.tasks[0].id]),
        ] {
            value[key] = ids;
            assert!(serde_json::from_value::<Snapshot>(value.clone())
                .unwrap()
                .validate()
                .is_err());
        }
        value[key] = Value::Null;
        assert!(serde_json::from_value::<Snapshot>(value.clone()).is_err());
        value.as_object_mut().unwrap().remove(key);
    }
}
