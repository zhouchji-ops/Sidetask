use super::Task;
use chrono::{DateTime, Datelike, LocalResult, NaiveDate, NaiveTime, SecondsFormat, TimeZone, Utc};
use chrono_tz::{GapInfo, Tz};

pub fn valid_date(value: &str) -> Result<NaiveDate, String> {
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| "日期格式无效，请使用 YYYY-MM-DD。".to_string())?;
    if value.len() != 10 || !(1..=9999).contains(&date.year()) || date.to_string() != value {
        return Err("日期格式无效，请使用 YYYY-MM-DD。".into());
    }
    Ok(date)
}
fn valid_time(value: &str) -> Result<NaiveTime, String> {
    let time = NaiveTime::parse_from_str(value, "%H:%M")
        .map_err(|_| "请选择有效的截止时间。".to_string())?;
    if value.len() != 5 || time.format("%H:%M").to_string() != value {
        return Err("请选择有效的截止时间。".into());
    }
    Ok(time)
}
pub fn parse_utc(value: &str) -> Result<DateTime<Utc>, String> {
    let invalid = || "时间记录不是有效的 UTC 瞬间。".to_string();
    let body = value
        .strip_suffix('Z')
        .or_else(|| value.strip_suffix("+00:00"))
        .ok_or_else(invalid)?;
    if !body.is_ascii() || body.len() < 19 || body.as_bytes()[10] != b'T' {
        return Err(invalid());
    }
    valid_date(&body[..10]).map_err(|_| invalid())?;
    valid_time(&body[11..16]).map_err(|_| invalid())?;
    if body.as_bytes()[16] != b':'
        || !body[17..19].bytes().all(|byte| byte.is_ascii_digit())
        || body[17..19].parse::<u8>().map_err(|_| invalid())? > 59
    {
        return Err(invalid());
    }
    if body.len() > 19 {
        let fraction = body[19..].strip_prefix('.').ok_or_else(invalid)?;
        if fraction.is_empty()
            || fraction.len() > 9
            || !fraction.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(invalid());
        }
    }
    let instant = DateTime::parse_from_rfc3339(value).map_err(|_| invalid())?;
    Ok(instant.with_timezone(&Utc))
}
fn parse_zone(zone: &str) -> Result<Tz, String> {
    zone.parse()
        .map_err(|_| "无法识别截止日期的 IANA 时区，请重新选择日期。".into())
}
/// The first valid instant of a calendar date. Midnight can be skipped or repeated.
fn day_start(day: NaiveDate, zone: Tz) -> Result<DateTime<Tz>, String> {
    let midnight = day.and_hms_opt(0, 0, 0).ok_or("日期边界无效。")?;
    match zone.from_local_datetime(&midnight) {
        LocalResult::Single(at) => Ok(at),
        LocalResult::Ambiguous(earlier, later) => Ok(earlier.min(later)),
        LocalResult::None => GapInfo::new(&midnight, &zone)
            .and_then(|gap| gap.end)
            .ok_or_else(|| "无法解释该时区的日期边界。".into()),
    }
}
fn resolve(date: &str, time: Option<&str>, zone: &str) -> Result<Option<String>, String> {
    let day = valid_date(date)?;
    let zone = parse_zone(zone)?;
    if day_start(day, zone)?.date_naive() != day {
        return Err("所选日期在该时区不存在，请选择其他日期。".into());
    }
    if let Some(time) = time {
        let local = day.and_time(valid_time(time)?);
        let at = match zone.from_local_datetime(&local) {
            LocalResult::Single(at) => at,
            LocalResult::Ambiguous(_, _) => {
                return Err("该时刻因夏令时出现两次，请选择其他时刻。".into())
            }
            LocalResult::None => return Err("该时刻因夏令时不存在，请选择其他时刻。".into()),
        };
        return Ok(Some(
            at.with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Secs, true),
        ));
    }
    Ok(None)
}
/// Only explicit deadline changes pin an old floating deadline; reads and note edits do not.
pub fn fix(task: &mut Task, previous: Option<&Task>) -> Result<(), String> {
    if previous.is_some_and(|old| {
        old.due_date == task.due_date
            && old.due_time == task.due_time
            && old.due_timezone == task.due_timezone
    }) {
        return Ok(());
    }
    let Some(date) = task.due_date.as_deref() else {
        task.due_timezone = None;
        task.due_at_utc = None;
        return Ok(());
    };
    let zone = task
        .due_timezone
        .clone()
        .or_else(|| previous.and_then(|old| old.due_timezone.clone()))
        .map(Ok)
        .unwrap_or_else(|| {
            iana_time_zone::get_timezone()
                .map_err(|_| "无法读取系统时区，请重新选择日期。".to_string())
        })?;
    task.due_at_utc = resolve(date, task.due_time.as_deref(), &zone)?;
    task.due_timezone = Some(zone);
    Ok(())
}
pub fn validate(task: &Task) -> Result<(), String> {
    if let Some(date) = &task.due_date {
        valid_date(date)?;
    }
    if let Some(time) = &task.due_time {
        if task.due_date.is_none() {
            return Err("请为截止时间选择有效日期和时刻。".into());
        }
        valid_time(time)?;
    }
    match (
        &task.due_date,
        &task.due_timezone,
        &task.due_time,
        &task.due_at_utc,
    ) {
        (None, None, None, None) => Ok(()),
        (None, _, _, _) => Err("无截止日期时不能保存时区或截止瞬间。".into()),
        (Some(_), None, _, None) => Ok(()), // Legacy records retain their previous meaning.
        (Some(date), Some(zone), None, None) => {
            resolve(date, None, zone)?;
            date_only_boundary(date, zone).map(|_| ())
        }
        (Some(_), Some(zone), Some(_), Some(at)) => {
            parse_zone(zone)?;
            // Preserve the committed instant even if a later tzdb release changes future offsets.
            parse_utc(at).map(|_| ())
        }
        _ => Err("截止日期、时区和精确瞬间不一致。".into()),
    }
}
/// Date-only DDL expires at the first valid instant of the following calendar date.
pub fn date_only_boundary(date: &str, zone: &str) -> Result<DateTime<Utc>, String> {
    let zone = parse_zone(zone)?;
    let next_day = valid_date(date)?.succ_opt().ok_or("日期超出范围。")?;
    Ok(day_start(next_day, zone)?.with_timezone(&Utc))
}
