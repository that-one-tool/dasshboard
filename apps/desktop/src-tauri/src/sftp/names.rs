//! Which server-supplied names are listed, and which are safe to write here.

use std::path::Path;

use crate::error::AppError;

/// Join a POSIX parent path and a child name for remote paths (root stays a
/// single leading slash, never `//child`).
pub(super) fn join_remote(parent: &str, name: &str) -> String {
    format!("{}/{}", parent.trim_end_matches('/'), name)
}

/// Whether a directory entry belongs in a listing: not `.`/`..`, and no `/`,
/// which no real file name can contain — only a hostile server sends one, to
/// steer a download out of the chosen folder (`../../.config/autostart/x`).
/// Names that are only invalid on *this* OS (`a\b` on Windows) stay listed so
/// they can be renamed or deleted; the frontend refuses to download them.
pub(super) fn is_listable_name(name: &str) -> bool {
    name != "." && name != ".." && !name.contains('/')
}

/// Whether a server-supplied directory-entry name is a single, ordinary path
/// component that is safe to join onto a local path. Rejects empty, `.`, `..`,
/// any name containing a path separator (`/`, or `\` on Windows), and absolute,
/// rooted, drive- or UNC-prefixed names. This closes a path-traversal hole: a
/// hostile or compromised SFTP server could otherwise return an entry named e.g.
/// `../../.bashrc` or an absolute path and steer a folder download's local write
/// **outside** the directory the user chose. Evaluated with the *local* OS's
/// path rules, since that is where the bytes are written.
fn is_safe_name(name: &str) -> bool {
    use std::path::Component;
    let mut components = Path::new(name).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(c)), None) => c == std::ffi::OsStr::new(name),
        _ => false,
    }
}

/// Whether a server-supplied name can be written into the download folder as
/// is: a single safe component ([`is_safe_name`]) that, on Windows, Windows can
/// store (`a:b`, `aux`, `x?` or `name.` can't be created there).
pub(super) fn is_storable_name(name: &str) -> bool {
    is_safe_name(name) && (!cfg!(windows) || crate::sftp_edit::is_windows_portable_name(name))
}

/// Refuses a download target whose file name this computer can't store (see
/// [`is_storable_name`]). The frontend names a folder or bulk download's
/// target after the server's entry, so on Windows `aux` would open a device
/// and `x::$DATA` write an alternate data stream.
pub(crate) fn ensure_storable_target(local: &Path) -> Result<(), AppError> {
    let name = local.file_name().and_then(|n| n.to_str());
    if name.is_some_and(is_storable_name) {
        return Ok(());
    }
    Err(AppError::Validation(format!(
        "{} is not a file name this computer can store",
        local.display()
    )))
}

#[cfg(test)]
mod tests {
    use super::{ensure_storable_target, is_listable_name, is_safe_name, join_remote};
    use std::path::Path;

    #[test]
    fn a_download_target_needs_a_storable_file_name() {
        assert!(ensure_storable_target(Path::new("/home/me/Downloads/report.pdf")).is_ok());
        assert!(ensure_storable_target(Path::new("/")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn a_download_target_windows_cant_store_is_refused() {
        // `x::$DATA` would write an alternate data stream; `aux` opens a device.
        for name in ["aux", "x::$DATA", "a:b", "name."] {
            let target = Path::new("C:\\Users\\me\\Downloads").join(name);
            assert!(ensure_storable_target(&target).is_err(), "{name:?}");
        }
    }

    #[test]
    fn is_listable_name_keeps_names_a_real_file_can_have() {
        for name in ["file.txt", ".hidden", r"a\b", "c:x", "..x"] {
            assert!(is_listable_name(name), "{name:?} should be listed");
        }
    }

    #[test]
    fn is_listable_name_drops_dot_entries_and_names_with_a_slash() {
        // No real directory entry contains `/`: only a hostile server sends one,
        // e.g. to steer a download with `../../.config/autostart/x`.
        for name in [".", "..", "a/b", "../evil", "/etc/passwd"] {
            assert!(!is_listable_name(name), "{name:?} must not be listed");
        }
    }

    #[test]
    fn join_remote_keeps_a_single_root_slash() {
        assert_eq!(join_remote("/", "child"), "/child");
        assert_eq!(join_remote("/a", "b"), "/a/b");
        assert_eq!(join_remote("/a/", "b"), "/a/b");
    }

    #[test]
    fn is_safe_name_accepts_ordinary_names() {
        for name in ["file.txt", "a folder", "weird-name_1", ".hidden", "résumé"] {
            assert!(is_safe_name(name), "{name:?} should be safe");
        }
    }

    #[test]
    fn is_safe_name_rejects_traversal_and_rooted_names() {
        // Empty, dot segments, and anything with a POSIX separator.
        for name in [
            "",
            ".",
            "..",
            "a/b",
            "../evil",
            "/etc/passwd",
            "a/../b",
            "/",
        ] {
            assert!(!is_safe_name(name), "{name:?} must be rejected");
        }
    }

    #[cfg(windows)]
    #[test]
    fn is_safe_name_rejects_windows_separators_and_prefixes() {
        // On Windows, `\` is a separator and drive/UNC prefixes must be rejected.
        for name in [
            r"a\b",
            r"..\evil",
            r"C:\Windows\x",
            r"\\host\share\x",
            r"C:x",
        ] {
            assert!(!is_safe_name(name), "{name:?} must be rejected on Windows");
        }
    }
}
