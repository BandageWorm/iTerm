use std::{
    env,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::{AppHandle, Manager};

const PORTABLE_MARKER: &str = "iterm.portable";
const PORTABLE_DATA_DIRECTORY: &str = "portable-data";
static WRITE_PROBE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug)]
pub(crate) struct AppDataPaths {
    pub data_directory: PathBuf,
    pub log_directory: PathBuf,
    pub portable: bool,
}

impl AppDataPaths {
    pub fn resolve(app: &AppHandle) -> Result<Self, String> {
        let executable =
            env::current_exe().map_err(|error| format!("无法定位程序所在目录：{error}"))?;
        // An AppImage executable runs inside a temporary, read-only mount.
        #[cfg(target_os = "linux")]
        let appimage = env::var_os("APPIMAGE").map(PathBuf::from);
        #[cfg(not(target_os = "linux"))]
        let appimage: Option<PathBuf> = None;
        let directory = application_directory(&executable, appimage.as_deref())?;
        if let Some(paths) = Self::portable_at(&directory)? {
            return Ok(paths);
        }
        Ok(Self {
            data_directory: app
                .path()
                .app_data_dir()
                .map_err(|error| format!("无法定位应用数据目录：{error}"))?,
            log_directory: app
                .path()
                .app_log_dir()
                .map_err(|error| format!("无法定位应用日志目录：{error}"))?,
            portable: false,
        })
    }

    fn portable_at(directory: &Path) -> Result<Option<Self>, String> {
        let marker = directory.join(PORTABLE_MARKER);
        match fs::metadata(&marker) {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => return Err(format!("便携模式标记必须是文件：{}", marker.display())),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(format!(
                    "无法读取便携模式标记 {}：{error}",
                    marker.display()
                ));
            }
        }
        let data_directory = directory.join(PORTABLE_DATA_DIRECTORY);
        prepare_portable_directory(&data_directory)?;
        let log_directory = data_directory.join("logs");
        prepare_portable_directory(&log_directory)?;
        #[cfg(not(target_os = "macos"))]
        prepare_portable_directory(&data_directory.join("webview"))?;
        Ok(Some(Self {
            data_directory,
            log_directory,
            portable: true,
        }))
    }
}

fn application_directory(executable: &Path, appimage: Option<&Path>) -> Result<PathBuf, String> {
    let executable = appimage.unwrap_or(executable);
    if !executable.is_absolute() {
        return Err(format!("程序路径必须是绝对路径：{}", executable.display()));
    }
    let directory = executable
        .parent()
        .ok_or_else(|| format!("无法定位程序所在目录：{}", executable.display()))?;
    // Keep portable data next to the .app, outside its signed bundle.
    if directory.file_name().is_some_and(|name| name == "MacOS") {
        if let Some(contents) = directory.parent() {
            if contents.file_name().is_some_and(|name| name == "Contents") {
                if let Some(bundle) = contents.parent() {
                    if bundle
                        .extension()
                        .is_some_and(|extension| extension == "app")
                    {
                        return bundle
                            .parent()
                            .map(Path::to_path_buf)
                            .ok_or_else(|| "无法定位 macOS 应用包所在目录。".to_string());
                    }
                }
            }
        }
    }
    Ok(directory.to_path_buf())
}

fn prepare_portable_directory(directory: &Path) -> Result<(), String> {
    let prepare = || -> io::Result<()> {
        fs::create_dir_all(directory)?;
        let sequence = WRITE_PROBE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let probe = directory.join(format!(
            ".iterm-write-test-{}-{sequence}",
            std::process::id()
        ));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)?;
        let result = file
            .write_all(b"iTerm portable storage")
            .and_then(|_| file.sync_all());
        drop(file);
        let cleanup = fs::remove_file(probe);
        result.and(cleanup)
    };
    prepare().map_err(|error| {
        format!(
            "便携数据目录不可写 {}：{error}。请将整个 iTerm 文件夹移到可写位置后重试；配置不会改存到系统目录。",
            directory.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let sequence = WRITE_PROBE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = env::temp_dir().join(format!(
                "iterm-portable-test-{}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn resolves_executable_appimage_and_macos_bundle_locations() {
        let root = env::temp_dir();
        assert_eq!(
            application_directory(&root.join("iterm.exe"), None).unwrap(),
            root
        );
        assert_eq!(
            application_directory(
                &root.join(".mount_iterm/usr/bin/iterm"),
                Some(&root.join("usb/iTerm.AppImage"))
            )
            .unwrap(),
            root.join("usb")
        );
        assert_eq!(
            application_directory(&root.join("usb/iTerm.app/Contents/MacOS/iterm"), None).unwrap(),
            root.join("usb")
        );
        assert!(application_directory(Path::new("iterm"), None).is_err());
        assert!(
            application_directory(&root.join("iterm"), Some(Path::new("iTerm.AppImage"))).is_err()
        );
    }

    #[test]
    fn does_not_create_data_without_a_portable_marker() {
        let root = TestDirectory::new();
        assert!(AppDataPaths::portable_at(&root.0).unwrap().is_none());
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 0);
    }

    #[test]
    fn portable_marker_keeps_all_directories_with_the_application() {
        let root = TestDirectory::new();
        fs::write(root.0.join(PORTABLE_MARKER), b"").unwrap();
        let paths = AppDataPaths::portable_at(&root.0).unwrap().unwrap();
        assert!(paths.portable);
        assert_eq!(paths.data_directory, root.0.join(PORTABLE_DATA_DIRECTORY));
        assert_eq!(paths.log_directory, paths.data_directory.join("logs"));
        assert!(paths.log_directory.is_dir());
        #[cfg(not(target_os = "macos"))]
        assert!(paths.data_directory.join("webview").is_dir());
        assert!(fs::read_dir(&paths.data_directory)
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".iterm-write-test")));
    }

    #[test]
    fn unusable_portable_data_does_not_fall_back_to_another_location() {
        let root = TestDirectory::new();
        fs::write(root.0.join(PORTABLE_MARKER), b"").unwrap();
        fs::write(root.0.join(PORTABLE_DATA_DIRECTORY), b"keep existing file").unwrap();
        let error = AppDataPaths::portable_at(&root.0).unwrap_err();
        assert!(error.contains("便携数据目录不可写"));
        assert!(error.contains(&root.0.to_string_lossy().to_string()));
        assert_eq!(
            fs::read(root.0.join(PORTABLE_DATA_DIRECTORY)).unwrap(),
            b"keep existing file"
        );
    }

    #[test]
    fn rejects_a_directory_used_as_the_marker() {
        let root = TestDirectory::new();
        fs::create_dir(root.0.join(PORTABLE_MARKER)).unwrap();
        assert!(AppDataPaths::portable_at(&root.0)
            .unwrap_err()
            .contains("便携模式标记必须是文件"));
        assert!(!root.0.join(PORTABLE_DATA_DIRECTORY).exists());
    }
}
