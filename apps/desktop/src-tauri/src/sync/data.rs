//! Account data and deterministic three-way merging, without network or storage access.
use crate::domain::{Plan, Snapshot, Task, MAX_SAFE_REVISION};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

const MAX_SYNC_BYTES: usize = 10 * 1024 * 1024;
const MAX_SYNC_TASKS: usize = 10_000;
const MAX_SYNC_PLANS: usize = 100_000;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncData {
    pub tasks: Vec<Task>,
    pub plans: Vec<Plan>,
    pub task_order: Vec<String>,
    pub deadline_order: Vec<String>,
}

impl SyncData {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn from_snapshot(snapshot: &Snapshot) -> Self {
        Self {
            tasks: snapshot
                .tasks
                .iter()
                .cloned()
                .map(without_revision)
                .collect(),
            plans: snapshot.plans.clone(),
            task_order: snapshot.task_order.clone(),
            deadline_order: snapshot.deadline_order.clone(),
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.tasks.len() > MAX_SYNC_TASKS || self.plans.len() > MAX_SYNC_PLANS {
            return Err("同步数据超过任务或计划数量上限。".into());
        }
        if self.task_order.len() > self.tasks.len() || self.deadline_order.len() > self.tasks.len()
        {
            return Err("同步顺序含有重复或不存在的任务。".into());
        }
        if self.tasks.iter().any(|task| task.revision != 0) {
            return Err("同步任务不能包含本机修订号。".into());
        }
        check_size(self)?;
        let mut snapshot = Snapshot::empty();
        snapshot.tasks = self.tasks.clone();
        for task in &mut snapshot.tasks {
            task.revision = 1;
        }
        snapshot.plans = self.plans.clone();
        snapshot.task_order = self.task_order.clone();
        snapshot.deadline_order = self.deadline_order.clone();
        snapshot.validate()
    }

    /// Revisions belong to this installation. Settings never enter the cloud document.
    pub fn apply_to(&self, local: &Snapshot) -> Result<Snapshot, String> {
        self.validate()?;
        local.validate()?;
        if *self == Self::from_snapshot(local) {
            return Ok(local.clone());
        }
        let desired_ids: BTreeSet<_> = self.tasks.iter().map(|task| task.id.as_str()).collect();
        if local
            .tasks
            .iter()
            .any(|task| !desired_ids.contains(task.id.as_str()))
        {
            return Err("同步结果缺少本机任务；请重新合并，不能直接删除记录。".into());
        }
        let revision = next_revision(local.revision)?;
        let old: BTreeMap<_, _> = local
            .tasks
            .iter()
            .map(|task| (task.id.as_str(), task))
            .collect();
        let mut tasks = Vec::with_capacity(self.tasks.len());
        for task in &self.tasks {
            let mut task = task.clone();
            task.revision = match old.get(task.id.as_str()) {
                Some(previous) if without_revision((*previous).clone()) == task => {
                    previous.revision
                }
                Some(previous) => next_revision(previous.revision)?,
                None => revision,
            };
            tasks.push(task);
        }
        let result = Snapshot {
            tasks,
            plans: self.plans.clone(),
            task_order: self.task_order.clone(),
            deadline_order: self.deadline_order.clone(),
            settings: local.settings.clone(),
            revision,
        };
        result.validate()?;
        // A conservative local bound includes settings and real revision digits.
        // TaskService additionally checks the exact portable-backup representation.
        check_size(&result)?;
        Ok(result)
    }
}

fn without_revision(mut task: Task) -> Task {
    task.revision = 0;
    task
}

fn check_size(value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|error| format!("同步数据编码失败：{error}"))?;
    if bytes.len() > MAX_SYNC_BYTES {
        return Err("同步数据超过 10 MiB，未写入任何更改。".into());
    }
    Ok(())
}

fn next_revision(revision: u64) -> Result<u64, String> {
    revision
        .checked_add(1)
        .filter(|value| *value <= MAX_SAFE_REVISION)
        .ok_or_else(|| "本机修订号已达安全上限，不能应用同步。".into())
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConflictChoice {
    Local,
    Remote,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MergeConflict {
    pub id: String,
    pub label: String,
    pub local: Value,
    pub remote: Value,
}

#[derive(Clone, Debug)]
pub struct MergeResult {
    pub data: SyncData,
    pub conflicts: Vec<MergeConflict>,
}

struct Merger<'a> {
    choices: &'a BTreeMap<String, ConflictChoice>,
    conflicts: Vec<MergeConflict>,
}

impl Merger<'_> {
    fn conflict<T: Clone + Serialize>(
        &mut self,
        id: String,
        label: String,
        local: &T,
        remote: &T,
    ) -> T {
        match self.choices.get(&id) {
            Some(ConflictChoice::Remote) => remote.clone(),
            Some(ConflictChoice::Local) => local.clone(),
            None => {
                self.conflicts.push(MergeConflict {
                    id,
                    label,
                    // All callers pass serializable domain values, never arbitrary floats.
                    local: serde_json::to_value(local).expect("serializable merge value"),
                    remote: serde_json::to_value(remote).expect("serializable merge value"),
                });
                local.clone()
            }
        }
    }

    fn field<T: Clone + PartialEq + Serialize>(
        &mut self,
        id: String,
        label: String,
        base: Option<&T>,
        local: &T,
        remote: &T,
    ) -> T {
        if local == remote || base == Some(remote) {
            local.clone()
        } else if base == Some(local) {
            remote.clone()
        } else {
            self.conflict(id, label, local, remote)
        }
    }

    fn task(&mut self, base: Option<&Task>, local: &Task, remote: &Task) -> Task {
        if local.created_at != remote.created_at {
            return self.conflict(
                conflict_id(&["task", &local.id, "identity"]),
                format!("任务“{}”的创建记录", local.title),
                local,
                remote,
            );
        }
        // A different creation record is an identity collision, not a useful ancestor.
        let base = base.filter(|task| task.created_at == local.created_at);
        let mut task = local.clone();
        let field_id = |field| conflict_id(&["task", &local.id, field]);
        let label = |field| format!("任务“{}”的{field}", local.title);
        task.title = self.field(
            field_id("title"),
            label("名称"),
            base.map(|t| &t.title),
            &local.title,
            &remote.title,
        );
        task.notes = self.field(
            field_id("notes"),
            label("备注"),
            base.map(|t| &t.notes),
            &local.notes,
            &remote.notes,
        );
        task.priority = self.field(
            field_id("priority"),
            label("重要程度"),
            base.map(|t| &t.priority),
            &local.priority,
            &remote.priority,
        );
        let due = self.field(
            field_id("deadline"),
            label("截止日期"),
            base.map(Deadline::from).as_ref(),
            &Deadline::from(local),
            &Deadline::from(remote),
        );
        task.due_date = due.due_date;
        task.due_time = due.due_time;
        task.due_timezone = due.due_timezone;
        task.due_at_utc = due.due_at_utc;
        let completed = self.field(
            field_id("completion"),
            label("完成状态"),
            base.map(Completion::from).as_ref(),
            &Completion::from(local),
            &Completion::from(remote),
        );
        task.completed = completed.completed;
        task.completed_at = completed.completed_at;
        task.deleted_at = self.field(
            field_id("deletedAt"),
            label("回收站状态"),
            base.map(|t| &t.deleted_at),
            &local.deleted_at,
            &remote.deleted_at,
        );
        task.revision = 0;
        task
    }
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Deadline {
    due_date: Option<String>,
    due_time: Option<String>,
    due_timezone: Option<String>,
    due_at_utc: Option<String>,
}

impl From<&Task> for Deadline {
    fn from(task: &Task) -> Self {
        Self {
            due_date: task.due_date.clone(),
            due_time: task.due_time.clone(),
            due_timezone: task.due_timezone.clone(),
            due_at_utc: task.due_at_utc.clone(),
        }
    }
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Completion {
    completed: bool,
    completed_at: Option<String>,
}

impl From<&Task> for Completion {
    fn from(task: &Task) -> Self {
        Self {
            completed: task.completed,
            completed_at: task.completed_at.clone(),
        }
    }
}

fn conflict_id(parts: &[&str]) -> String {
    json!(parts).to_string()
}

/// No clocks participate in conflict resolution. Missing tasks are retained, including
/// baseline-only records; a deletion is represented exclusively by `deletedAt`.
pub fn merge(
    base: &SyncData,
    local: &SyncData,
    remote: &SyncData,
    choices: &BTreeMap<String, ConflictChoice>,
) -> Result<MergeResult, String> {
    base.validate()?;
    local.validate()?;
    remote.validate()?;
    if base == local && local == remote {
        return Ok(MergeResult {
            data: local.clone(),
            conflicts: vec![],
        });
    }
    let mut merger = Merger {
        choices,
        conflicts: vec![],
    };
    let index = |data: &SyncData| {
        data.tasks
            .iter()
            .map(|task| (task.id.clone(), task.clone()))
            .collect::<BTreeMap<_, _>>()
    };
    let base_tasks = index(base);
    let local_tasks = index(local);
    let remote_tasks = index(remote);
    let mut seen = BTreeSet::new();
    let mut tasks = Vec::new();
    // Preserve the published append order, then append private and baseline-only tasks.
    for entry in remote.tasks.iter().chain(&local.tasks).chain(&base.tasks) {
        if !seen.insert(entry.id.clone()) {
            continue;
        }
        let ancestor = base_tasks.get(&entry.id);
        let local = local_tasks.get(&entry.id).or(ancestor);
        let remote = remote_tasks.get(&entry.id).or(ancestor);
        let task = match (local, remote) {
            (Some(local), Some(remote)) => merger.task(ancestor, local, remote),
            (Some(task), None) | (None, Some(task)) => task.clone(),
            (None, None) => unreachable!("ID comes from one input"),
        };
        tasks.push(task);
    }
    let plans = merge_plans(&mut merger, &base.plans, &local.plans, &remote.plans);
    let task_order = merge_manual_order(
        &mut merger,
        "all",
        "全部任务的手动顺序",
        &base.task_order,
        &local.task_order,
        &remote.task_order,
    );
    let deadline_order = merge_manual_order(
        &mut merger,
        "deadlines",
        "截止日期的手动顺序",
        &base.deadline_order,
        &local.deadline_order,
        &remote.deadline_order,
    );
    let data = SyncData {
        tasks,
        plans,
        task_order,
        deadline_order,
    };
    data.validate()?;
    Ok(MergeResult {
        data,
        conflicts: merger.conflicts,
    })
}

fn merged_members(base: &[String], local: &[String], remote: &[String]) -> BTreeSet<String> {
    let base: BTreeSet<_> = base.iter().collect();
    let local: BTreeSet<_> = local.iter().collect();
    let remote: BTreeSet<_> = remote.iter().collect();
    base.iter()
        .chain(&local)
        .chain(&remote)
        .filter_map(|id| {
            let (b, l, r) = (base.contains(id), local.contains(id), remote.contains(id));
            let keep = if l == r || r == b { l } else { r };
            keep.then(|| (**id).clone())
        })
        .collect()
}

fn project(sequence: &[String], members: &BTreeSet<String>) -> Vec<String> {
    sequence
        .iter()
        .filter(|id| members.contains(*id))
        .cloned()
        .collect()
}

fn fill_sequence(
    seed: &[String],
    members: &BTreeSet<String>,
    local: &[String],
    remote: &[String],
    base: &[String],
) -> Vec<String> {
    let mut seen = BTreeSet::new();
    seed.iter()
        .chain(remote)
        .chain(local)
        .chain(base)
        .chain(members)
        .filter(|id| members.contains(*id) && seen.insert((*id).clone()))
        .cloned()
        .collect()
}

fn merge_sequence(
    merger: &mut Merger<'_>,
    id: String,
    label: String,
    members: &BTreeSet<String>,
    base: &[String],
    local: &[String],
    remote: &[String],
) -> Vec<String> {
    let base = project(base, members);
    let local = project(local, members);
    let remote = project(remote, members);
    let seed = if local == remote || remote == base {
        local.clone()
    } else if local == base {
        remote.clone()
    } else {
        let remote_set: BTreeSet<_> = remote.iter().collect();
        let shared: BTreeSet<String> = local
            .iter()
            .filter(|id| remote_set.contains(id))
            .cloned()
            .collect();
        let old_shared: BTreeSet<String> = base
            .iter()
            .filter(|id| shared.contains(*id))
            .cloned()
            .collect();
        let old_base = project(&base, &old_shared);
        let old_local = project(&local, &old_shared);
        let old_remote = project(&remote, &old_shared);
        let local_changed = old_local != old_base;
        let remote_changed = old_remote != old_base;
        let different = old_local != old_remote;
        // Shared new items have no common ancestor. Opposing positions require a choice,
        // including the first connection between two already populated installations.
        let shared_new_conflict = shared.len() != old_shared.len()
            && project(&local, &shared) != project(&remote, &shared);
        if (local_changed && remote_changed && different) || shared_new_conflict {
            merger.conflict(id, label, &local, &remote)
        } else if local_changed {
            local.clone()
        } else {
            remote.clone()
        }
    };
    fill_sequence(&seed, members, &local, &remote, &base)
}

fn merge_manual_order(
    merger: &mut Merger<'_>,
    scope: &str,
    label: &str,
    base: &[String],
    local: &[String],
    remote: &[String],
) -> Vec<String> {
    let id = conflict_id(&["order", scope]);
    let base_set: BTreeSet<_> = base.iter().cloned().collect();
    let local_set: BTreeSet<_> = local.iter().cloned().collect();
    let remote_set: BTreeSet<_> = remote.iter().cloned().collect();
    let removed_local = !base_set.is_subset(&local_set);
    let removed_remote = !base_set.is_subset(&remote_set);
    let reordered_local = project(local, &base_set) != project(base, &local_set);
    let reordered_remote = project(remote, &base_set) != project(base, &remote_set);
    if (removed_local && reordered_remote) || (removed_remote && reordered_local) {
        // A backup can clear a sparse rank list while another device reorders it.
        // Do not silently discard that reorder; new ranked items survive either choice.
        let seed = merger.conflict(id, label.into(), &local.to_vec(), &remote.to_vec());
        let mut members: BTreeSet<_> = seed.iter().cloned().collect();
        members.extend(
            local
                .iter()
                .chain(remote)
                .filter(|id| !base_set.contains(*id))
                .cloned(),
        );
        return fill_sequence(&seed, &members, local, remote, base);
    }
    let members = merged_members(base, local, remote);
    merge_sequence(merger, id, label.into(), &members, base, local, remote)
}

fn plans_by_day(plans: &[Plan]) -> BTreeMap<String, Vec<Plan>> {
    let mut days: BTreeMap<String, Vec<Plan>> = BTreeMap::new();
    for plan in plans {
        days.entry(plan.date.clone())
            .or_default()
            .push(plan.clone());
    }
    days
}

fn plan_sequence(plans: &[Plan]) -> Vec<String> {
    let mut sorted: Vec<_> = plans.iter().collect();
    sorted.sort_by_key(|plan| plan.sort_order);
    sorted
        .into_iter()
        .map(|plan| plan.task_id.clone())
        .collect()
}

fn merge_plans(
    merger: &mut Merger<'_>,
    base: &[Plan],
    local: &[Plan],
    remote: &[Plan],
) -> Vec<Plan> {
    if base == local && local == remote {
        return local.to_vec();
    }
    let (base, local, remote) = (
        plans_by_day(base),
        plans_by_day(local),
        plans_by_day(remote),
    );
    let dates: BTreeSet<_> = base
        .keys()
        .chain(local.keys())
        .chain(remote.keys())
        .collect();
    let mut plans = Vec::new();
    for date in dates {
        let b = base.get(date).map(Vec::as_slice).unwrap_or_default();
        let l = local.get(date).map(Vec::as_slice).unwrap_or_default();
        let r = remote.get(date).map(Vec::as_slice).unwrap_or_default();
        if b == l && l == r {
            plans.extend_from_slice(l);
            continue;
        }
        let (b, l, r) = (plan_sequence(b), plan_sequence(l), plan_sequence(r));
        let members = merged_members(&b, &l, &r);
        let sequence = merge_sequence(
            merger,
            conflict_id(&["planOrder", date]),
            format!("{date} 的计划顺序"),
            &members,
            &b,
            &l,
            &r,
        );
        plans.extend(
            sequence
                .into_iter()
                .enumerate()
                .map(|(sort_order, task_id)| Plan {
                    task_id,
                    date: date.clone(),
                    sort_order,
                }),
        );
    }
    plans
}

#[cfg(test)]
mod tests {
    use super::*;

    const TODAY: &str = "2026-10-04";
    fn task(id: &str) -> Task {
        Task {
            id: id.into(),
            title: id.into(),
            notes: String::new(),
            priority: "normal".into(),
            due_date: None,
            due_time: None,
            due_timezone: None,
            due_at_utc: None,
            completed: false,
            created_at: "2026-10-01T12:00:00Z".into(),
            completed_at: None,
            deleted_at: None,
            revision: 0,
        }
    }
    fn ids(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| (*id).into()).collect()
    }
    fn data(ids: &[&str]) -> SyncData {
        SyncData {
            tasks: ids.iter().map(|id| task(id)).collect(),
            ..SyncData::empty()
        }
    }
    fn plans(ids: &[&str], date: &str) -> Vec<Plan> {
        ids.iter()
            .enumerate()
            .map(|(sort_order, id)| Plan {
                task_id: (*id).into(),
                date: date.into(),
                sort_order,
            })
            .collect()
    }
    fn merged(base: &SyncData, local: &SyncData, remote: &SyncData) -> MergeResult {
        merge(base, local, remote, &BTreeMap::new()).unwrap()
    }
    fn choose(
        base: &SyncData,
        local: &SyncData,
        remote: &SyncData,
        id: &[&str],
        choice: ConflictChoice,
    ) -> MergeResult {
        merge(
            base,
            local,
            remote,
            &BTreeMap::from([(conflict_id(id), choice)]),
        )
        .unwrap()
    }

    #[test]
    fn independent_task_edits_merge_without_clocks_or_local_revisions() {
        let base = data(&["a"]);
        let mut local = base.clone();
        let mut remote = base.clone();
        local.tasks[0].title = "本机名称".into();
        remote.tasks[0].notes = "另一端备注".into();
        let result = merged(&base, &local, &remote);
        assert!(result.conflicts.is_empty());
        assert_eq!(result.data.tasks[0].title, "本机名称");
        assert_eq!(result.data.tasks[0].notes, "另一端备注");
        assert_eq!(result.data.tasks[0].revision, 0);
        assert!(result.data.task_order.is_empty());
        assert!(result.data.deadline_order.is_empty());
    }

    #[test]
    fn field_choice_does_not_discard_other_fields() {
        let base = data(&["a|title"]);
        let mut local = base.clone();
        let mut remote = base.clone();
        local.tasks[0].title = "本机".into();
        local.tasks[0].priority = "high".into();
        remote.tasks[0].title = "远端".into();
        remote.tasks[0].notes = "共享备注".into();
        let unresolved = merged(&base, &local, &remote);
        assert_eq!(unresolved.conflicts.len(), 1);
        assert_eq!(
            unresolved.conflicts[0].id,
            "[\"task\",\"a|title\",\"title\"]"
        );
        assert_eq!(unresolved.conflicts[0].local, json!("本机"));
        assert_eq!(unresolved.conflicts[0].remote, json!("远端"));
        let resolved = choose(
            &base,
            &local,
            &remote,
            &["task", "a|title", "title"],
            ConflictChoice::Remote,
        );
        assert!(resolved.conflicts.is_empty());
        let task = &resolved.data.tasks[0];
        assert_eq!(
            (&*task.title, &*task.notes, &*task.priority),
            ("远端", "共享备注", "high")
        );
    }

    #[test]
    fn delete_and_edit_preserve_both_and_missing_records_never_delete() {
        let base = data(&["a", "b"]);
        let mut local = base.clone();
        let mut remote = base.clone();
        local.tasks[0].deleted_at = Some("2026-10-04T09:00:00Z".into());
        remote.tasks[0].notes = "离线编辑".into();
        remote.tasks.pop();
        local.tasks.pop();
        let result = merged(&base, &local, &remote);
        assert!(result.conflicts.is_empty());
        assert_eq!(result.data.tasks.len(), 2);
        assert!(result.data.tasks[0].deleted_at.is_some());
        assert_eq!(result.data.tasks[0].notes, "离线编辑");
        assert_eq!(result.data.tasks[1], base.tasks[1]);
    }

    #[test]
    fn deadline_and_completion_are_atomic_groups() {
        let base = data(&["a"]);
        let mut local = base.clone();
        let mut remote = base.clone();
        local.tasks[0].due_date = Some("2026-10-05".into());
        remote.tasks[0].due_date = Some("2026-10-06".into());
        remote.tasks[0].due_time = Some("12:00".into());
        remote.tasks[0].due_timezone = Some("UTC".into());
        remote.tasks[0].due_at_utc = Some("2026-10-06T12:00:00Z".into());
        local.tasks[0].completed = true;
        local.tasks[0].completed_at = Some("2026-10-04T01:00:00Z".into());
        remote.tasks[0].completed = true;
        remote.tasks[0].completed_at = Some("2026-10-04T02:00:00Z".into());
        let result = merged(&base, &local, &remote);
        assert_eq!(result.conflicts.len(), 2);
        let resolved = merge(
            &base,
            &local,
            &remote,
            &BTreeMap::from([
                (
                    conflict_id(&["task", "a", "deadline"]),
                    ConflictChoice::Remote,
                ),
                (
                    conflict_id(&["task", "a", "completion"]),
                    ConflictChoice::Local,
                ),
            ]),
        )
        .unwrap();
        assert!(resolved.conflicts.is_empty());
        assert!(Deadline::from(&resolved.data.tasks[0]) == Deadline::from(&remote.tasks[0]));
        assert!(Completion::from(&resolved.data.tasks[0]) == Completion::from(&local.tasks[0]));
    }

    #[test]
    fn same_id_different_creation_requires_whole_record_choice() {
        let base = data(&["a"]);
        let mut local = base.clone();
        let mut remote = base.clone();
        local.tasks[0].notes = "旧身份编辑".into();
        remote.tasks[0].created_at = "2026-10-02T12:00:00Z".into();
        remote.tasks[0].title = "同 ID 新身份".into();
        let result = merged(&base, &local, &remote);
        assert_eq!(result.conflicts.len(), 1);
        assert_eq!(
            result.conflicts[0].id,
            conflict_id(&["task", "a", "identity"])
        );
        let resolved = choose(
            &base,
            &local,
            &remote,
            &["task", "a", "identity"],
            ConflictChoice::Remote,
        );
        assert_eq!(resolved.data.tasks[0], remote.tasks[0]);
    }

    #[test]
    fn first_connection_unions_private_tasks_and_reports_shared_conflicts() {
        let base = SyncData::empty();
        let mut local = data(&["a", "local"]);
        let mut remote = data(&["a", "remote"]);
        local.tasks[0].notes = "左".into();
        remote.tasks[0].notes = "右".into();
        local.plans = plans(&["a", "local"], TODAY);
        remote.plans = plans(&["a", "remote"], TODAY);
        let result = merged(&base, &local, &remote);
        assert_eq!(result.data.tasks.len(), 3);
        assert_eq!(result.data.plans.len(), 3);
        assert_eq!(result.conflicts.len(), 1);
        assert_eq!(result.conflicts[0].id, conflict_id(&["task", "a", "notes"]));
        assert!(result.data.task_order.is_empty());
    }

    #[test]
    fn removing_today_propagates_without_deleting_task_or_other_day() {
        let mut base = data(&["a", "b"]);
        base.plans = plans(&["a", "b"], TODAY);
        base.plans.extend(plans(&["a"], "2026-10-05"));
        base.tasks[0].due_date = Some("2026-10-07".into());
        let mut local = base.clone();
        let mut remote = base.clone();
        local
            .plans
            .retain(|plan| !(plan.task_id == "a" && plan.date == TODAY));
        remote.tasks[0].notes = "另一端编辑".into();
        let result = merged(&base, &local, &remote);
        assert!(result.conflicts.is_empty());
        assert_eq!(
            result
                .data
                .plans
                .iter()
                .filter(|p| p.task_id == "a")
                .count(),
            1
        );
        assert_eq!(result.data.tasks[0].due_date.as_deref(), Some("2026-10-07"));
        assert!(!result.data.tasks[0].completed);
    }

    #[test]
    fn reorder_and_other_device_new_task_merge_for_each_order() {
        let mut base = data(&["a", "b", "c"]);
        base.task_order = ids(&["a", "b", "c"]);
        base.deadline_order = base.task_order.clone();
        base.plans = plans(&["a", "b", "c"], TODAY);
        let mut local = base.clone();
        let mut remote = base.clone();
        local.task_order = ids(&["c", "a", "b"]);
        local.deadline_order = ids(&["b", "c", "a"]);
        local.plans = plans(&["c", "b", "a"], TODAY);
        remote.tasks.push(task("new"));
        remote.task_order.push("new".into());
        remote.deadline_order.push("new".into());
        remote.plans.push(Plan {
            task_id: "new".into(),
            date: TODAY.into(),
            sort_order: 3,
        });
        let result = merged(&base, &local, &remote);
        assert!(result.conflicts.is_empty());
        assert_eq!(result.data.task_order, ids(&["c", "a", "b", "new"]));
        assert_eq!(result.data.deadline_order, ids(&["b", "c", "a", "new"]));
        assert_eq!(
            plan_sequence(&result.data.plans),
            ids(&["c", "b", "a", "new"])
        );
    }

    #[test]
    fn concurrent_orders_conflict_independently_and_keep_new_items() {
        let mut base = data(&["a", "hidden", "b", "c"]);
        base.tasks[1].deleted_at = Some("2026-10-03T12:00:00Z".into());
        base.task_order = ids(&["a", "hidden", "b", "c"]);
        base.deadline_order = ids(&["a", "b", "c"]);
        base.plans = plans(&["a", "b", "c"], TODAY);
        let mut local = base.clone();
        let mut remote = base.clone();
        local.task_order = ids(&["b", "hidden", "a", "c"]);
        remote.task_order = ids(&["c", "hidden", "b", "a"]);
        local.deadline_order = ids(&["b", "a", "c"]);
        remote.plans = plans(&["c", "a", "b"], TODAY);
        remote.tasks.push(task("new"));
        remote.task_order.push("new".into());
        let result = merged(&base, &local, &remote);
        assert_eq!(result.conflicts.len(), 1);
        assert_eq!(result.conflicts[0].id, conflict_id(&["order", "all"]));
        let resolved = choose(
            &base,
            &local,
            &remote,
            &["order", "all"],
            ConflictChoice::Local,
        );
        assert!(resolved.conflicts.is_empty());
        assert_eq!(
            resolved.data.task_order,
            ids(&["b", "hidden", "a", "c", "new"])
        );
        assert_eq!(resolved.data.deadline_order, local.deadline_order);
        assert_eq!(plan_sequence(&resolved.data.plans), ids(&["c", "a", "b"]));
        assert_eq!(resolved.data.tasks[1].deleted_at, base.tasks[1].deleted_at);
    }

    #[test]
    fn removing_plan_and_remote_reorder_reorders_remaining_members() {
        let mut base = data(&["a", "b", "c"]);
        base.plans = plans(&["a", "b", "c"], TODAY);
        let mut local = base.clone();
        let mut remote = base.clone();
        local.plans = plans(&["b", "c"], TODAY);
        remote.plans = plans(&["c", "a", "b"], TODAY);
        let result = merged(&base, &local, &remote);
        assert!(result.conflicts.is_empty());
        assert_eq!(plan_sequence(&result.data.plans), ids(&["c", "b"]));
    }

    #[test]
    fn first_connection_different_shared_orders_are_explicit_conflicts() {
        let base = SyncData::empty();
        let mut local = data(&["a", "b"]);
        let mut remote = local.clone();
        local.task_order = ids(&["a", "b"]);
        remote.task_order = ids(&["b", "a"]);
        local.plans = plans(&["a", "b"], TODAY);
        remote.plans = plans(&["b", "a"], TODAY);
        let result = merged(&base, &local, &remote);
        assert_eq!(result.conflicts.len(), 2);
    }

    #[test]
    fn cleared_manual_order_and_concurrent_reorder_require_choice() {
        let mut base = data(&["a", "b", "new"]);
        base.task_order = ids(&["a", "b"]);
        let mut local = base.clone();
        let mut remote = base.clone();
        local.task_order.clear();
        remote.task_order = ids(&["b", "a", "new"]);
        assert_eq!(merged(&base, &local, &remote).conflicts.len(), 1);
        let resolved = choose(
            &base,
            &local,
            &remote,
            &["order", "all"],
            ConflictChoice::Local,
        );
        assert_eq!(resolved.data.task_order, ids(&["new"]));
        let unchanged = merged(&base, &local, &base);
        assert!(unchanged.data.task_order.is_empty());
    }

    #[test]
    fn applying_preserves_settings_and_only_bumps_changed_task_revisions() {
        let mut local = Snapshot::empty();
        local.tasks = data(&["a", "b"]).tasks;
        for task in &mut local.tasks {
            task.revision = 3;
        }
        local.revision = 7;
        local.settings.theme = "dark".into();
        local.settings.ddl_sort = "priority".into();
        let mut remote = SyncData::from_snapshot(&local);
        remote.tasks[0].notes = "同步编辑".into();
        remote.task_order = ids(&["b", "a"]);
        remote.tasks.push(task("new"));
        let next = remote.apply_to(&local).unwrap();
        assert_eq!(next.revision, 8);
        assert_eq!(next.tasks[0].revision, 4);
        assert_eq!(next.tasks[1].revision, 3);
        assert_eq!(next.tasks[2].revision, 8);
        assert_eq!(next.settings, local.settings);
        assert_eq!(remote.apply_to(&next).unwrap().revision, 8);
        let mut reordered = remote.clone();
        reordered.task_order.reverse();
        let next = reordered.apply_to(&next).unwrap();
        assert_eq!(next.revision, 9);
        assert_eq!(next.tasks[0].revision, 4);
        assert_eq!(next.tasks[1].revision, 3);
    }

    #[test]
    fn revision_limit_rejects_change_but_allows_identical_data() {
        let mut local = Snapshot::empty();
        local.tasks = data(&["a"]).tasks;
        local.revision = MAX_SAFE_REVISION;
        local.tasks[0].revision = MAX_SAFE_REVISION;
        let data = SyncData::from_snapshot(&local);
        assert_eq!(data.apply_to(&local).unwrap().revision, MAX_SAFE_REVISION);
        let mut changed = data;
        changed.tasks[0].title = "新名称".into();
        assert!(changed.apply_to(&local).is_err());
    }

    #[test]
    fn validate_rejects_local_revisions_duplicates_missing_references_and_oversize() {
        let valid = data(&["a"]);
        let mut invalid = valid.clone();
        invalid.tasks[0].revision = 1;
        assert!(invalid.validate().is_err());
        let mut invalid = valid.clone();
        invalid.tasks.push(task("a"));
        assert!(invalid.validate().is_err());
        let mut invalid = valid.clone();
        invalid.task_order = ids(&["missing"]);
        assert!(invalid.validate().is_err());
        let mut invalid = valid.clone();
        invalid.deadline_order = ids(&["a", "a"]);
        assert!(invalid.validate().is_err());
        let mut invalid = valid.clone();
        invalid.plans = plans(&["missing"], TODAY);
        assert!(invalid.validate().is_err());
        let mut invalid = SyncData::empty();
        for i in 0..1_100 {
            let mut task = task(&format!("large-{i}"));
            task.notes = "x".repeat(10_000);
            invalid.tasks.push(task);
        }
        assert!(invalid.validate().unwrap_err().contains("10 MiB"));
        let mut value = serde_json::to_value(valid).unwrap();
        value["settings"] = json!({});
        assert!(serde_json::from_value::<SyncData>(value).is_err());
    }

    #[test]
    fn invalid_remote_and_incomplete_application_leave_input_unchanged() {
        let base = data(&["a"]);
        let local = base.clone();
        let mut remote = base.clone();
        remote.tasks[0].due_time = Some("23:00".into());
        assert!(merge(&base, &local, &remote, &BTreeMap::new()).is_err());
        assert_eq!(base, local);
        let snapshot = base.apply_to(&Snapshot::empty()).unwrap();
        assert!(SyncData::empty().apply_to(&snapshot).is_err());
        assert_eq!(snapshot.tasks.len(), 1);
    }

    #[test]
    fn unchanged_data_does_not_rewrite_sparse_plan_ranks() {
        let mut base = data(&["a", "b"]);
        base.plans = plans(&["a", "b"], TODAY);
        base.plans[1].sort_order = 50;
        let mut local = base.clone();
        local.tasks[0].notes = "单独编辑".into();
        let result = merged(&base, &local, &base);
        assert_eq!(result.data.plans, base.plans);
        assert!(result.data.task_order.is_empty());
    }

    #[test]
    fn merged_document_round_trips_and_converges_without_repeating_conflicts() {
        let mut base = data(&["a", "b", "c"]);
        base.task_order = ids(&["a", "b", "c"]);
        base.plans = plans(&["a", "b", "c"], TODAY);
        let mut local = base.clone();
        let mut remote = base.clone();
        local.tasks.push(task("local"));
        local.plans.push(Plan {
            task_id: "local".into(),
            date: TODAY.into(),
            sort_order: 3,
        });
        remote.tasks.push(task("remote"));
        remote.task_order = ids(&["c", "b", "a", "remote"]);
        remote.tasks[1].notes = "另一端的变更".into();
        let result = merged(&base, &local, &remote);
        assert!(result.conflicts.is_empty());
        assert_eq!(result.data.task_order, remote.task_order);
        assert_eq!(result.data.tasks.len(), 5);
        assert_eq!(result.data.plans.len(), 4);
        let published: SyncData =
            serde_json::from_str(&serde_json::to_string(&result.data).unwrap()).unwrap();
        assert_eq!(published, result.data);
        // Either installation can repeat the request after a lost acknowledgement.
        let retried = merged(&base, &local, &published);
        assert!(retried.conflicts.is_empty());
        assert_eq!(retried.data, published);
        let converged = merged(&remote, &remote, &published);
        assert!(converged.conflicts.is_empty());
        assert_eq!(converged.data, published);
    }

    #[test]
    fn capacity_failure_of_combined_valid_inputs_preserves_both_sources() {
        let mut local = SyncData::empty();
        let mut remote = SyncData::empty();
        for i in 0..1_100 {
            let mut task = task(&format!("task-{i}"));
            task.notes = "x".repeat(10_000);
            if i % 2 == 0 {
                local.tasks.push(task);
            } else {
                remote.tasks.push(task);
            }
        }
        local.validate().unwrap();
        remote.validate().unwrap();
        let failure = merge(&SyncData::empty(), &local, &remote, &BTreeMap::new()).unwrap_err();
        assert!(failure.contains("10 MiB"));
        assert_eq!((local.tasks.len(), remote.tasks.len()), (550, 550));
        assert_eq!(local.tasks[0].notes.len(), 10_000);
        assert_eq!(remote.tasks[0].notes.len(), 10_000);
    }
}
