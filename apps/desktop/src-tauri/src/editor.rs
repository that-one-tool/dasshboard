//! Opening an SFTP edit's local copy in an external editor: the user's editor
//! command from settings when set, otherwise a text editor (see
//! `text_editor_argv`).
//!
//! The command is split into arguments here and run directly — never through a
//! shell — so a remote file name can't inject anything. Inside the Flatpak
//! sandbox it runs on the host through `flatpak-spawn --host` (the edit copies
//! live in the app's cache dir, which the host sees at the same path).

use std::path::Path;
use std::process::{Command, Stdio};

use tauri::{AppHandle, Runtime};
use tauri_plugin_opener::OpenerExt;

use crate::error::AppError;
use crate::flatpak;

/// Where the file path goes in an editor command; appended when absent.
const FILE_PLACEHOLDER: &str = "{file}";

/// Open `file` with `command` (see [`editor_argv`]), or with the system's
/// text editor when `command` is blank (see [`text_editor_argv`]). The editor
/// is not waited for.
pub fn open_in_editor<R: Runtime>(
    app: &AppHandle<R>,
    command: &str,
    file: &Path,
) -> Result<(), AppError> {
    let sandboxed = flatpak::is_sandboxed();
    let argv = match command.trim() {
        "" => text_editor_argv(path_arg(file), sandboxed),
        command => Some(editor_argv(command, file)?),
    };
    match argv {
        Some(argv) => spawn_detached(&on_host(argv, sandboxed)),
        None => open_with_default_app(app, file),
    }
}

fn open_with_default_app<R: Runtime>(app: &AppHandle<R>, file: &Path) -> Result<(), AppError> {
    app.opener()
        .open_path(path_arg(file), None::<&str>)
        .map_err(|e| AppError::Io(format!("could not open {}: {e}", file.display())))
}

/// The fallback editor when no command is set. Never the file's own default
/// action: on Windows that *runs* a `.bat`, `.vbs`, `.exe`, … and on macOS a
/// `.terminal` file, so a hostile server could name a file to have Edit run
/// it. Windows uses Notepad and macOS the default text editor (`open -t`).
/// On Linux `xdg-open` picks the handler by type and runs nothing (the copy
/// is not executable); `None` means "use the opener plugin", which calls it.
#[cfg(windows)]
fn text_editor_argv(path: String, _sandboxed: bool) -> Option<Vec<String>> {
    Some(vec!["notepad.exe".to_string(), path])
}

#[cfg(target_os = "macos")]
fn text_editor_argv(path: String, _sandboxed: bool) -> Option<Vec<String>> {
    Some(vec!["open".to_string(), "-t".to_string(), path])
}

/// In the Flatpak sandbox the host's `xdg-open` opens the copy directly (it
/// sits in a folder the host sees), rather than through a portal.
#[cfg(not(any(windows, target_os = "macos")))]
fn text_editor_argv(path: String, sandboxed: bool) -> Option<Vec<String>> {
    sandboxed.then(|| vec!["xdg-open".to_string(), path])
}

/// The argument vector for `command` opening `file`: the command split like a
/// shell would on whitespace (single or double quotes group, no escapes, so a
/// Windows path keeps its backslashes), with every `{file}` replaced by the
/// path — or the path appended when there is no placeholder.
pub fn editor_argv(command: &str, file: &Path) -> Result<Vec<String>, AppError> {
    let words = split_command(command)?;
    if words.is_empty() {
        return Err(AppError::Validation("the editor command is empty".into()));
    }
    let path = path_arg(file);
    if !words.iter().any(|w| w.contains(FILE_PLACEHOLDER)) {
        return Ok(words.into_iter().chain([path]).collect());
    }
    Ok(words
        .into_iter()
        .map(|w| w.replace(FILE_PLACEHOLDER, &path))
        .collect())
}

fn path_arg(file: &Path) -> String {
    file.to_string_lossy().into_owned()
}

/// Whitespace-separated words; quotes group and are removed.
fn split_command(command: &str) -> Result<Vec<String>, AppError> {
    let mut splitter = WordSplitter::default();
    command.chars().for_each(|c| splitter.feed(c));
    splitter.finish()
}

#[derive(Default)]
struct WordSplitter {
    words: Vec<String>,
    /// The word being read; `Some("")` after an empty `""` still counts.
    word: Option<String>,
    /// The quote character while inside quotes.
    quote: Option<char>,
}

impl WordSplitter {
    fn feed(&mut self, c: char) {
        match self.quote {
            Some(quote) => self.feed_quoted(quote, c),
            None => self.feed_bare(c),
        }
    }

    fn feed_quoted(&mut self, quote: char, c: char) {
        if c == quote {
            self.quote = None;
        } else {
            self.word().push(c);
        }
    }

    fn feed_bare(&mut self, c: char) {
        if matches!(c, '"' | '\'') {
            self.quote = Some(c);
            self.word();
        } else if c.is_whitespace() {
            self.words.extend(self.word.take());
        } else {
            self.word().push(c);
        }
    }

    fn word(&mut self) -> &mut String {
        self.word.get_or_insert_with(String::new)
    }

    fn finish(mut self) -> Result<Vec<String>, AppError> {
        if self.quote.is_some() {
            return Err(AppError::Validation(
                "the editor command has an unclosed quote".into(),
            ));
        }
        self.words.extend(self.word);
        Ok(self.words)
    }
}

/// In the sandbox, run `argv` on the host instead.
fn on_host(argv: Vec<String>, sandboxed: bool) -> Vec<String> {
    if !sandboxed {
        return argv;
    }
    ["flatpak-spawn", "--host"]
        .into_iter()
        .map(String::from)
        .chain(argv)
        .collect()
}

/// Start `argv` without waiting for it; a background thread reaps it so it
/// never lingers as a zombie.
fn spawn_detached(argv: &[String]) -> Result<(), AppError> {
    let mut child = spawn(argv)
        .map_err(|e| AppError::Io(format!("could not start the editor \"{}\": {e}", argv[0])))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn spawn(argv: &[String]) -> std::io::Result<std::process::Child> {
    let first = command_for(&argv[0], &argv[1..]).spawn();
    match first {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            retry_as_batch(argv).unwrap_or(Err(e))
        }
        other => other,
    }
}

/// Windows only finds `.exe` programs by bare name, but many editor launchers
/// on the PATH are `.cmd` scripts (`code`, `subl`): retry with the extension.
fn retry_as_batch(argv: &[String]) -> Option<std::io::Result<std::process::Child>> {
    let has_extension = Path::new(&argv[0]).extension().is_some();
    if !cfg!(windows) || has_extension {
        return None;
    }
    Some(command_for(&format!("{}.cmd", argv[0]), &argv[1..]).spawn())
}

fn command_for(program: &str, args: &[String]) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window flashing up for a `.cmd` launcher.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(command: &str) -> Vec<String> {
        editor_argv(command, Path::new("/tmp/e/app.conf")).unwrap()
    }

    #[test]
    fn the_path_is_appended_when_there_is_no_placeholder() {
        assert_eq!(argv("code"), ["code", "/tmp/e/app.conf"]);
        assert_eq!(
            argv("  gedit   --new-window "),
            ["gedit", "--new-window", "/tmp/e/app.conf"]
        );
    }

    #[test]
    fn the_placeholder_is_replaced_wherever_it_appears() {
        assert_eq!(
            argv("subl --wait {file}:1"),
            ["subl", "--wait", "/tmp/e/app.conf:1"]
        );
        assert_eq!(
            argv("kate --file={file}"),
            ["kate", "--file=/tmp/e/app.conf"]
        );
    }

    #[test]
    fn quotes_group_words_and_keep_backslashes() {
        assert_eq!(
            argv(r#""C:\Program Files\Notepad++\notepad++.exe" -multiInst"#),
            [
                r"C:\Program Files\Notepad++\notepad++.exe",
                "-multiInst",
                "/tmp/e/app.conf"
            ]
        );
        assert_eq!(argv("'my editor' ''"), ["my editor", "", "/tmp/e/app.conf"]);
    }

    #[test]
    fn a_path_with_spaces_stays_one_argument() {
        let got = editor_argv("code", Path::new("/tmp/my dir/a b.txt")).unwrap();
        assert_eq!(got, ["code", "/tmp/my dir/a b.txt"]);
    }

    #[test]
    fn blank_or_unbalanced_commands_are_rejected() {
        let file = Path::new("/f");
        assert!(matches!(
            editor_argv("   ", file),
            Err(AppError::Validation(_))
        ));
        assert!(matches!(
            editor_argv("code \"oops", file),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn in_the_sandbox_the_editor_runs_on_the_host() {
        let argv = vec!["code".to_string(), "/f".to_string()];
        assert_eq!(on_host(argv.clone(), false), argv);
        assert_eq!(
            on_host(argv, true),
            ["flatpak-spawn", "--host", "code", "/f"]
        );
    }

    #[cfg(windows)]
    #[test]
    fn without_a_command_windows_uses_notepad() {
        assert_eq!(
            text_editor_argv("C:\\e\\run.bat".into(), false),
            Some(vec![
                "notepad.exe".to_string(),
                "C:\\e\\run.bat".to_string()
            ])
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn without_a_command_macos_uses_the_text_editor() {
        assert_eq!(
            text_editor_argv("/e/x.terminal".into(), false),
            Some(vec![
                "open".to_string(),
                "-t".to_string(),
                "/e/x.terminal".to_string()
            ])
        );
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    #[test]
    fn without_a_command_linux_uses_xdg_open() {
        assert_eq!(text_editor_argv("/e/a.conf".into(), false), None);
        assert_eq!(
            text_editor_argv("/e/a.conf".into(), true),
            Some(vec!["xdg-open".to_string(), "/e/a.conf".to_string()])
        );
    }

    #[test]
    fn a_missing_program_is_an_io_error() {
        let err = spawn_detached(&["dasshboard-no-such-editor-xyz".to_string()]).unwrap_err();
        assert!(matches!(err, AppError::Io(_)));
    }
}
