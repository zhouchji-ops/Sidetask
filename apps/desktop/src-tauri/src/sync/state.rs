use super::data::SyncData;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};

pub const MAX_REVISION: u64 = 9_007_199_254_740_991;
pub const MAX_DOCUMENT_BYTES: usize = 10 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncConfig {
    pub project_url: String,
    pub publishable_key: String,
}
impl SyncConfig {
    pub fn new(project_url: String, publishable_key: String) -> Result<Self, String> {
        let mut config = Self {
            project_url: project_url.trim().trim_end_matches('/').to_string(),
            publishable_key: publishable_key.trim().to_string(),
        };
        config.validate()?;
        let url = reqwest::Url::parse(&config.project_url).map_err(|_| "项目地址无效。")?;
        config.project_url = format!("https://{}", url.host_str().unwrap_or_default());
        Ok(config)
    }
    pub fn validate(&self) -> Result<(), String> {
        let url = reqwest::Url::parse(&self.project_url)
            .map_err(|_| "请填写 Supabase 项目的 HTTPS 地址。")?;
        let host = url.host_str().unwrap_or_default();
        let project = host.strip_suffix(".supabase.co").unwrap_or_default();
        if url.scheme() != "https"
            || project.is_empty()
            || project.len() > 80
            || !project
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || !["", "/"].contains(&url.path())
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("请使用 https://项目标识.supabase.co，不能含路径或登录信息。".into());
        }
        let key = &self.publishable_key;
        let publishable = key.starts_with("sb_publishable_")
            && key.len() > 20
            && key.len() < 4096
            && key
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-');
        let parts: Vec<_> = key.split('.').collect();
        let anon = parts.len() == 3
            && key.len() < 4096
            && URL_SAFE_NO_PAD
                .decode(parts[1])
                .ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                .is_some_and(|claims| claims["role"] == "anon");
        if !publishable && !anon {
            return Err(
                "请填写 publishable key 或旧版 anon key；不能使用 secret / service_role 密钥。"
                    .into(),
            );
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncBinding {
    pub user_id: String,
    pub email: String,
    pub config: SyncConfig,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncState {
    pub device_id: String,
    pub binding: Option<SyncBinding>,
    pub enabled: bool,
    pub remote_revision: u64,
    pub baseline: SyncData,
    pub last_synced_at: Option<String>,
}
impl Default for SyncState {
    fn default() -> Self {
        Self {
            device_id: uuid::Uuid::new_v4().to_string(),
            binding: None,
            enabled: false,
            remote_revision: 0,
            baseline: SyncData::default(),
            last_synced_at: None,
        }
    }
}
impl SyncState {
    pub fn validate(&self) -> Result<(), String> {
        uuid::Uuid::parse_str(&self.device_id).map_err(|_| "同步设备标识无效。")?;
        if self.remote_revision > MAX_REVISION {
            return Err("同步版本超出支持范围。".into());
        }
        if let Some(binding) = &self.binding {
            uuid::Uuid::parse_str(&binding.user_id).map_err(|_| "同步用户标识无效。")?;
            if binding.email.is_empty()
                || binding.email.len() > 320
                || binding.email.chars().any(char::is_control)
            {
                return Err("同步账号邮箱无效。".into());
            }
            binding.config.validate()?;
        } else if self.enabled
            || self.remote_revision != 0
            || self.baseline != SyncData::default()
            || self.last_synced_at.is_some()
        {
            return Err("未连接账号不能保存同步基线。".into());
        }
        if let Some(time) = &self.last_synced_at {
            chrono::DateTime::parse_from_rfc3339(time).map_err(|_| "同步时间无效。")?;
        }
        self.baseline.validate()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn key() -> String {
        "sb_publishable_test_only_123456789".into()
    }
    #[test]
    fn hosted_https_and_public_keys_only() {
        assert!(SyncConfig::new("https://test.supabase.co/".into(), key()).is_ok());
        for url in [
            "http://test.supabase.co",
            "https://test.supabase.co.evil.test",
            "https://user@test.supabase.co",
            "https://test.supabase.co/path",
            "https://test.supabase.co?x=1",
            "https://localhost",
        ] {
            assert!(SyncConfig::new(url.into(), key()).is_err(), "{url}");
        }
        assert!(
            SyncConfig::new("https://test.supabase.co".into(), "sb_secret_test".into()).is_err()
        );
        let service_key = format!(
            "e30.{}.test",
            URL_SAFE_NO_PAD.encode(br#"{"role":"service_role"}"#)
        );
        assert!(SyncConfig::new("https://test.supabase.co".into(), service_key).is_err());
    }
}
