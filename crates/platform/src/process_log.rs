use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Environment variable the Launcher uses to hand its resolved log directory
/// down to the Host Runtime and Desktop Controller. Those processes only read
/// it; they never re-derive a platform path, so the three components cannot
/// drift onto different directories.
pub const LOG_DIRECTORY_ENV: &str = "CODEXHOST_LOG_DIR";

/// Disk budget per component: the live file plus one rotated backup.
pub const DEFAULT_MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

const REDACTED: &str = "[redacted]";

/// Credential keywords redaction reacts to. These MUST stay in step with
/// `SENSITIVE_VALUE_PATTERN` in `packages/harness-adapter/src/diagnostics.ts`
/// so the same text is redacted identically in both languages.
const SENSITIVE_KEYWORDS: &[&str] = &[
    "api_key",
    "api-key",
    "apikey",
    "access_token",
    "access-token",
    "accesstoken",
    "auth",
    "authorization",
    "password",
    "secret",
];

/// Resolves the platform log directory: `~/Library/Logs/codexhost` on macOS,
/// `%LOCALAPPDATA%\codexhost\logs` on Windows, and the XDG state directory on
/// Linux. Mirrors the three-platform shape of `default_descriptor_path`.
pub fn default_log_directory() -> io::Result<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is unavailable"))?;
        Ok(home.join("Library").join("Logs").join("codexhost"))
    }
    #[cfg(target_os = "windows")]
    {
        let root = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, "LOCALAPPDATA is unavailable")
            })?;
        Ok(root.join("codexhost").join("logs"))
    }
    #[cfg(target_os = "linux")]
    {
        let root = std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(|home| PathBuf::from(home).join(".local").join("state"))
            })
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    "XDG_STATE_HOME and HOME are unavailable",
                )
            })?;
        Ok(root.join("codexhost"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "codexhost log directories support Windows, macOS, and Linux only",
        ))
    }
}

/// Replaces credential-shaped values with `[redacted]`. Mirrors
/// `sanitizeDiagnosticTail`'s redaction half (its length cap does not apply
/// here because every record is already a single bounded line).
#[must_use]
pub fn redact_secrets(value: &str) -> String {
    let mut result = redact_bearer(value);
    // Every match is redacted, not just the first: a launcher line routinely
    // carries more than one credential-shaped assignment.
    let mut search_from = 0;
    while let Some((value_start, value_end)) = sensitive_value_range(&result[search_from..]) {
        let start = search_from + value_start;
        let end = search_from + value_end;
        result = format!("{}[redacted]{}", &result[..start], &result[end..]);
        search_from = start + REDACTED.len();
    }
    result
}

/// Replaces `Bearer <token>` while keeping the scheme itself readable, which
/// is what keeps a log line diagnosable after redaction.
fn redact_bearer(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    let mut result = String::with_capacity(value.len());
    let mut cursor = 0;
    while let Some(found) = lower[cursor..].find("bearer") {
        let start = cursor + found;
        let after = start + "bearer".len();
        if start > 0 && !is_bearer_boundary(lower.as_bytes()[start - 1]) {
            cursor = after;
            continue;
        }
        let rest = &value[after..];
        let trimmed = rest.trim_start();
        let spaces = rest.len() - trimmed.len();
        if spaces == 0 {
            cursor = after;
            continue;
        }
        let token_len = trimmed
            .bytes()
            .take_while(|byte| is_bearer_token_byte(*byte))
            .count();
        if token_len == 0 {
            cursor = after;
            continue;
        }
        result.push_str(&value[cursor..after]);
        result.push_str("Bearer ");
        result.push_str(REDACTED);
        cursor = after + spaces + token_len;
    }
    result.push_str(&value[cursor..]);
    result
}

fn is_bearer_boundary(byte: u8) -> bool {
    !(byte.is_ascii_alphanumeric() || byte == b'_')
}

fn is_bearer_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'+' | b'/' | b'=' | b'-')
}

/// Locates the value span of a `<keyword><separator><value>` match starting
/// anywhere in `value`, mirroring the capture group layout of the TypeScript
/// pattern. Returns the half-open byte range of the value alone so the caller
/// keeps the keyword and separator verbatim.
fn sensitive_value_range(value: &str) -> Option<(usize, usize)> {
    let lower = value.to_ascii_lowercase();
    for keyword in SENSITIVE_KEYWORDS {
        let mut from = 0;
        while let Some(found) = lower[from..].find(keyword) {
            let start = from + found;
            let after = start + keyword.len();
            let separator = separator_length(&value[after..]);
            if separator == 0 {
                from = after;
                continue;
            }
            let value_start = after + separator;
            let value_len = value[value_start..]
                .bytes()
                .take_while(|byte| !byte.is_ascii_whitespace() && !matches!(byte, b',' | b';'))
                .count();
            if value_len == 0 {
                from = after;
                continue;
            }
            return Some((value_start, value_start + value_len));
        }
    }
    None
}

/// Matches the `\s*[:=]\s*` separator, returning its total byte length.
fn separator_length(value: &str) -> usize {
    let bytes = value.as_bytes();
    let mut cursor = 0;
    while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
        cursor += 1;
    }
    if cursor >= bytes.len() || (bytes[cursor] != b':' && bytes[cursor] != b'=') {
        return 0;
    }
    cursor += 1;
    while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
        cursor += 1;
    }
    cursor
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

impl LogLevel {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

/// A size-bounded, per-component log file. Writing never panics and never
/// propagates failure: a process that cannot write its log must still start and
/// still run, so every error is swallowed after the first one.
#[derive(Debug)]
pub struct ProcessLog {
    component: String,
    path: PathBuf,
    max_bytes: u64,
    file: Mutex<Option<File>>,
}

impl ProcessLog {
    pub fn open(component: &str, directory: &Path, max_bytes: u64) -> io::Result<Self> {
        create_private_directory(directory)?;
        let path = directory.join(format!("{component}.log"));
        let file = open_append(&path)?;
        Ok(Self {
            component: component.to_string(),
            path,
            max_bytes,
            file: Mutex::new(Some(file)),
        })
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn info(&self, message: &str) {
        self.write(LogLevel::Info, message);
    }

    pub fn warn(&self, message: &str) {
        self.write(LogLevel::Warn, message);
    }

    pub fn error(&self, message: &str) {
        self.write(LogLevel::Error, message);
    }

    fn write(&self, level: LogLevel, message: &str) {
        let mut record = format!(
            "{} pid={} level={} component={} {}",
            iso8601_utc_now(),
            std::process::id(),
            level.as_str(),
            self.component,
            redact_secrets(message)
        );
        let Ok(mut guard) = self.file.lock() else {
            return;
        };
        let Some(file) = guard.as_mut() else {
            return;
        };
        if rotate_if_needed(&self.path, record.len() as u64, self.max_bytes) {
            match open_append(&self.path) {
                Ok(reopened) => *file = reopened,
                Err(_) => return,
            }
        }
        // The terminator joins the record in the same buffer. `writeln!` would
        // issue a second syscall, and the launcher writes from two processes
        // at once, so a split record interleaves into its neighbour and the
        // log stops being readable.
        // The terminator joins the record in the same buffer. `writeln!` would
        // issue a second syscall, and the launcher writes from two processes
        // at once, so a split record interleaves into its neighbour and the
        // log stops being readable.
        record.push('\n');
        let _ = file.write_all(record.as_bytes());
        let _ = file.flush();
    }
}

/// Logs can name user directories, ports and Harness identities, so the
/// directory is owner-only rather than inheriting the ambient umask.
fn create_private_directory(directory: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(directory)?;
        // Creating an existing directory is a no-op, and an earlier run may
        // have left it group- or world-readable. Tighten it either way.
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(directory)?;
    }
    Ok(())
}

fn open_append(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

/// Keeps disk use bounded at `2 * max_bytes`: once the live file would exceed
/// the limit it becomes `.1` and a fresh file takes its place.
fn rotate_if_needed(path: &Path, incoming: u64, max_bytes: u64) -> bool {
    if max_bytes == 0 {
        return false;
    }
    let current = fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if current + incoming <= max_bytes {
        return false;
    }
    let backup = path.with_extension("log.1");
    let _ = fs::remove_file(&backup);
    fs::rename(path, backup).is_ok()
}

fn iso8601_utc_now() -> String {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = elapsed.as_secs();
    let millis = elapsed.subsec_millis();
    let days = (seconds / 86_400) as i64;
    let time_of_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        time_of_day / 3600,
        (time_of_day % 3600) / 60,
        time_of_day % 60,
    )
}

/// Civil calendar date from a day count relative to 1970-01-01.
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let shifted = days_since_epoch + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_position = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_position + 2) / 5 + 1) as u32;
    let month = if month_position < 10 {
        month_position + 3
    } else {
        month_position - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::{LogLevel, ProcessLog, civil_from_days, iso8601_utc_now, redact_secrets};
    use crate::temporary_directory;

    #[test]
    fn keeps_records_intact_when_two_writers_share_a_file() {
        let directory = temporary_directory("process-log-concurrent");
        // Separate handles on purpose: the launcher really does write from a
        // parent and a child process at the same moment, and that is the shape
        // that used to splice two records into one unreadable line.
        // Both handles name the same component, so they append to the same
        // file exactly as a launcher parent and its child do.
        let left = ProcessLog::open("shared", &directory, u64::MAX).expect("left log");
        let right = ProcessLog::open("shared", &directory, u64::MAX).expect("right log");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let left_writer = {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                for index in 0..500 {
                    left.info(&format!("left record {index}"));
                }
            })
        };
        let right_writer = {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                for index in 0..500 {
                    right.error(&format!("right record {index}"));
                }
            })
        };
        left_writer.join().expect("left writer");
        right_writer.join().expect("right writer");

        let contents = std::fs::read_to_string(directory.join("shared.log")).expect("read log");
        assert!(
            contents.ends_with('\n'),
            "log must end on a record boundary"
        );
        for line in contents.lines() {
            assert!(
                line.contains(" pid="),
                "record was spliced into a neighbour: {line}"
            );
        }
        assert_eq!(contents.lines().count(), 1000, "every record must survive");
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn redacts_sensitive_assignments() {
        assert_eq!(
            redact_secrets("launch failed API_KEY=sk-abc123"),
            "launch failed API_KEY=[redacted]"
        );
        // Parity with `sanitizeDiagnosticTail`: the Bearer pass runs first,
        // then the assignment pass still sees `Authorization: Bearer` and
        // redacts the now-literal `Bearer` token a second time. The double
        // redaction is the reference behaviour, not a defect in this port.
        assert_eq!(
            redact_secrets("Authorization: Bearer abc.def-ghi"),
            "Authorization: [redacted] [redacted]"
        );
        assert_eq!(
            redact_secrets("access_token = tok_12345 and secret: s3cr3t"),
            "access_token = [redacted] and secret: [redacted]"
        );
    }

    #[test]
    fn redacts_without_matching_ordinary_words() {
        assert_eq!(
            redact_secrets("authenticating harness pi"),
            "authenticating harness pi"
        );
        assert_eq!(
            redact_secrets("password policy is not set"),
            "password policy is not set"
        );
    }

    #[test]
    fn redacts_each_occurrence_in_a_line() {
        assert_eq!(
            redact_secrets("a=API_KEY=one b=PASSWORD=two"),
            "a=API_KEY=[redacted] b=PASSWORD=[redacted]"
        );
    }

    #[test]
    fn writes_pid_level_and_component_on_every_record() {
        let directory = temporary_directory("codexhost-process-log");
        let log = ProcessLog::open("launcher", &directory, DEFAULT_MAX_LOG_BYTES_FOR_TESTS)
            .expect("open log");
        log.info("Host chain ready");
        log.error("Desktop Controller exited");
        let contents = std::fs::read_to_string(log.path()).expect("read log");
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains(&format!("pid={}", std::process::id())));
        assert!(lines[0].contains("level=info"));
        assert!(lines[0].contains("component=launcher"));
        assert!(lines[1].contains("level=error"));
    }

    #[test]
    fn rotates_into_a_single_backup() {
        const CAP: u64 = 256;
        let directory = temporary_directory("codexhost-process-log");
        let log = ProcessLog::open("launcher", &directory, CAP).expect("open log");
        for index in 0..8 {
            log.info(&format!("event {index}"));
        }
        let live = std::fs::metadata(log.path()).expect("live file").len();
        let backup = log.path().with_extension("log.1");
        assert!(live <= CAP, "live file must stay under the cap, got {live}");
        let rotated = std::fs::metadata(&backup).expect("rotated backup").len();
        assert!(
            rotated <= CAP,
            "backup must stay under the cap, got {rotated}"
        );
    }

    #[test]
    fn never_splits_a_record_across_the_rotation_boundary() {
        // A single record larger than the cap is still written whole: the cap
        // bounds steady-state growth, it does not truncate diagnostics.
        let directory = temporary_directory("codexhost-process-log");
        let log = ProcessLog::open("launcher", &directory, 16).expect("open log");
        log.info("an event far longer than the configured cap");
        let contents = std::fs::read_to_string(log.path()).expect("read log");
        assert_eq!(contents.lines().count(), 1);
        assert!(contents.contains("an event far longer than the configured cap"));
    }

    #[test]
    fn formats_epoch_days_as_civil_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
    }

    #[test]
    fn level_names_are_stable() {
        assert_eq!(LogLevel::Info.as_str(), "info");
        assert_eq!(LogLevel::Warn.as_str(), "warn");
        assert_eq!(LogLevel::Error.as_str(), "error");
    }

    #[cfg(unix)]
    #[test]
    fn keeps_the_log_directory_and_file_owner_only() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let directory = temporary_directory("codexhost-process-log");
        let log = ProcessLog::open("launcher", &directory, DEFAULT_MAX_LOG_BYTES_FOR_TESTS)
            .expect("open log");
        log.info("sensitive surroundings");

        let directory_mode = fs::metadata(&directory)
            .expect("directory")
            .permissions()
            .mode();
        let file_mode = fs::metadata(log.path()).expect("file").permissions().mode();
        assert_eq!(
            directory_mode & 0o777,
            0o700,
            "log directory must be owner-only"
        );
        assert_eq!(file_mode & 0o777, 0o600, "log file must be owner-only");
    }

    #[test]
    fn current_timestamp_is_iso8601_utc() {
        let stamp = iso8601_utc_now();
        assert!(stamp.ends_with('Z'), "timestamp must be UTC: {stamp}");
        assert_eq!(stamp.len(), 24, "unexpected timestamp shape: {stamp}");
    }

    const DEFAULT_MAX_LOG_BYTES_FOR_TESTS: u64 = 1024 * 1024;
}
