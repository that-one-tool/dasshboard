//! The command library: named, reusable commands the user sends to the focused
//! pane or the broadcast set, persisted to `commands.json` with the shared
//! atomic-write + corrupt-recovery plumbing.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::atomic_file;
use crate::error::AppError;

const COMMANDS_FILE: &str = "commands.json";
const CURRENT_VERSION: u32 = 1;

/// One saved command. `run`: each line is followed by Enter; otherwise the text
/// is typed in for the user to finish, so it must be a single line (a line
/// break would run it anyway).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedCommand {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub text: String,
    #[serde(default)]
    pub run: bool,
}

impl SavedCommand {
    pub fn validate(&self) -> Result<(), AppError> {
        if self.name.trim().is_empty() {
            return Err(invalid("name must not be empty"));
        }
        if self.text.trim().is_empty() {
            return Err(invalid("command must not be empty"));
        }
        if !self.run && self.text.contains(['\n', '\r']) {
            return Err(invalid("a command typed in without Enter must be one line"));
        }
        if self.text.chars().any(is_forbidden_control) {
            return Err(invalid("a command must not contain control characters"));
        }
        Ok(())
    }

    fn with_id(mut self) -> Self {
        if self.id.trim().is_empty() {
            self.id = Uuid::new_v4().to_string();
        }
        self
    }
}

/// A control character could act on the shell by itself (Ctrl+O runs the line
/// in bash, ESC sequences edit it) while staying invisible in the UI.
fn is_forbidden_control(c: char) -> bool {
    c.is_control() && !matches!(c, '\t' | '\n' | '\r')
}

fn upsert_into(commands: &mut Vec<SavedCommand>, command: SavedCommand) {
    match commands.iter_mut().find(|c| c.id == command.id) {
        Some(existing) => *existing = command,
        None => commands.push(command),
    }
}

fn invalid(message: &str) -> AppError {
    AppError::Validation(message.to_string())
}

#[derive(Debug, Serialize, Deserialize)]
struct CommandsFile {
    version: u32,
    #[serde(default)]
    commands: Vec<SavedCommand>,
}

pub struct CommandStore {
    dir: PathBuf,
    state: Mutex<Vec<SavedCommand>>,
}

impl CommandStore {
    /// A missing file yields no commands; a corrupt one is backed up first.
    pub fn load(dir: PathBuf) -> Self {
        let state = atomic_file::read_recovering::<CommandsFile, _>(
            &dir,
            COMMANDS_FILE,
            |file| file.commands,
            Vec::new,
        );
        Self {
            dir,
            state: Mutex::new(state),
        }
    }

    /// Re-reads the file, so commands another running instance saved show up
    /// here and survive this instance's next save.
    pub fn reload(&self) {
        let reread = atomic_file::reread_recovering::<CommandsFile, _>(
            &self.dir,
            COMMANDS_FILE,
            |file| file.commands,
            Vec::new,
        );
        if let Some(state) = reread {
            *atomic_file::lock(&self.state) = state;
        }
    }

    pub fn list(&self) -> Vec<SavedCommand> {
        atomic_file::lock(&self.state).clone()
    }

    /// An empty id creates the command with a fresh UUID; a known id replaces
    /// it in place; an unknown one creates it with that id (an import).
    pub fn upsert(&self, command: SavedCommand) -> Result<SavedCommand, AppError> {
        let command = command.with_id();
        command.validate()?;
        self.mutate(|commands| {
            upsert_into(commands, command.clone());
            Ok(())
        })?;
        Ok(command)
    }

    /// [`Self::upsert`] for many, validated first and saved in one write: all
    /// or none. Returns the count saved.
    pub fn upsert_all(&self, incoming: Vec<SavedCommand>) -> Result<usize, AppError> {
        let incoming: Vec<SavedCommand> = incoming.into_iter().map(SavedCommand::with_id).collect();
        incoming.iter().try_for_each(SavedCommand::validate)?;
        let count = incoming.len();
        self.mutate(|commands| {
            incoming.into_iter().for_each(|c| upsert_into(commands, c));
            Ok(())
        })?;
        Ok(count)
    }

    pub fn delete(&self, id: &str) -> Result<(), AppError> {
        self.mutate(|commands| {
            let index = commands
                .iter()
                .position(|c| c.id == id)
                .ok_or_else(|| AppError::NotFound(format!("no command with id {id}")))?;
            commands.remove(index);
            Ok(())
        })
    }

    /// Edits a copy, persists it, then commits: a failed write leaves memory
    /// matching the disk.
    fn mutate(
        &self,
        edit: impl FnOnce(&mut Vec<SavedCommand>) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        let mut guard = atomic_file::lock(&self.state);
        let mut next = guard.clone();
        edit(&mut next)?;
        let file = CommandsFile {
            version: CURRENT_VERSION,
            commands: next,
        };
        atomic_file::write_json(&self.dir, COMMANDS_FILE, &file)?;
        *guard = file.commands;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn command(name: &str, text: &str, run: bool) -> SavedCommand {
        SavedCommand {
            id: String::new(),
            name: name.to_string(),
            text: text.to_string(),
            run,
        }
    }

    fn store_in(dir: &tempfile::TempDir) -> CommandStore {
        CommandStore::load(dir.path().to_path_buf())
    }

    #[test]
    fn a_command_needs_a_name_and_a_text() {
        assert!(command(" ", "uptime", true).validate().is_err());
        assert!(command("Uptime", " \n", true).validate().is_err());
        assert!(command("Uptime", "uptime", true).validate().is_ok());
    }

    #[test]
    fn only_a_run_command_may_span_several_lines() {
        assert!(command("Two", "cd /tmp\nls", true).validate().is_ok());
        assert!(command("Two", "cd /tmp\nls", false).validate().is_err());
        assert!(command("Cr", "sudo \r", false).validate().is_err());
        assert!(command("One", "sudo systemctl restart ", false)
            .validate()
            .is_ok());
    }

    #[test]
    fn control_characters_are_refused_except_tabs_and_a_run_command_line_breaks() {
        for text in [
            "uptime\u{f}",
            "ls\u{1b}[201~",
            "a\u{3}",
            "a\u{7f}",
            "a\u{9b}",
        ] {
            assert!(command("C", text, true).validate().is_err(), "{text:?}");
        }
        assert!(command("Tab", "echo\ta", false).validate().is_ok());
        assert!(command("Lines", "a\r\nb", true).validate().is_ok());
    }

    #[test]
    fn upsert_all_saves_every_command_in_one_write_or_none() {
        let dir = tempdir().unwrap();
        let store = store_in(&dir);
        let saved = store
            .upsert_all(vec![command("A", "a", true), command("B", "b", true)])
            .unwrap();
        assert_eq!(saved, 2);
        assert!(saved_ids_are_unique(&store));

        let bad = vec![command("C", "c", true), command("", "x", true)];
        assert!(store.upsert_all(bad).is_err());
        assert_eq!(store.list().len(), 2);
    }

    fn saved_ids_are_unique(store: &CommandStore) -> bool {
        let ids: std::collections::HashSet<String> =
            store.list().into_iter().map(|c| c.id).collect();
        ids.len() == store.list().len()
    }

    #[test]
    fn missing_file_yields_no_commands_and_creates_nothing() {
        let dir = tempdir().unwrap();
        assert!(store_in(&dir).list().is_empty());
        assert!(!dir.path().join(COMMANDS_FILE).exists());
    }

    #[test]
    fn upsert_with_empty_id_creates_with_a_fresh_uuid() {
        let dir = tempdir().unwrap();
        let saved = store_in(&dir)
            .upsert(command("Uptime", "uptime", true))
            .unwrap();
        assert!(Uuid::parse_str(&saved.id).is_ok());
    }

    #[test]
    fn upsert_with_a_known_id_replaces_in_place() {
        let dir = tempdir().unwrap();
        let store = store_in(&dir);
        let first = store.upsert(command("A", "a", true)).unwrap();
        store.upsert(command("B", "b", true)).unwrap();
        let edited = SavedCommand {
            text: "aa".to_string(),
            ..first.clone()
        };
        store.upsert(edited.clone()).unwrap();
        assert_eq!(store.list()[0], edited);
        assert_eq!(store.list().len(), 2);
    }

    #[test]
    fn upsert_rejects_an_invalid_command_without_writing() {
        let dir = tempdir().unwrap();
        let store = store_in(&dir);
        assert!(store.upsert(command("", "x", true)).is_err());
        assert!(store.list().is_empty());
        assert!(!dir.path().join(COMMANDS_FILE).exists());
    }

    #[test]
    fn delete_removes_the_command_and_an_unknown_id_is_not_found() {
        let dir = tempdir().unwrap();
        let store = store_in(&dir);
        let saved = store.upsert(command("A", "a", true)).unwrap();
        store.delete(&saved.id).unwrap();
        assert!(store.list().is_empty());
        assert!(matches!(
            store.delete(&saved.id),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn commands_round_trip_across_loads_with_a_versioned_file() {
        let dir = tempdir().unwrap();
        let saved = store_in(&dir).upsert(command("A", "a", false)).unwrap();
        assert_eq!(store_in(&dir).list(), vec![saved]);
        let raw = fs::read_to_string(dir.path().join(COMMANDS_FILE)).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(value["commands"][0]["run"], false);
    }

    #[test]
    fn reload_picks_up_commands_another_instance_saved() {
        let dir = tempdir().unwrap();
        let store = store_in(&dir);
        store_in(&dir).upsert(command("Other", "o", true)).unwrap();
        store.reload();
        store.upsert(command("Mine", "m", true)).unwrap();
        let names: Vec<String> = store_in(&dir).list().into_iter().map(|c| c.name).collect();
        assert_eq!(names, ["Other", "Mine"]);
    }

    #[test]
    fn a_failed_write_leaves_memory_unchanged() {
        let dir = tempdir().unwrap();
        let blocked = dir.path().join("blocked");
        fs::write(&blocked, "a file, not a dir").unwrap();
        let store = CommandStore::load(blocked);
        assert!(store.upsert(command("A", "a", true)).is_err());
        assert!(store.list().is_empty());
    }

    #[test]
    fn corrupt_file_is_backed_up_and_starts_empty() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(COMMANDS_FILE), "{ not json ").unwrap();
        assert!(store_in(&dir).list().is_empty());
        let backups = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("commands.json.corrupt-")
            })
            .count();
        assert_eq!(backups, 1);
    }
}
