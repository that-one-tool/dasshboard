//! This machine's hostname: how Xauthority names a local X server.

#[cfg(unix)]
pub(crate) fn local_hostname() -> String {
    let uname = rustix::system::uname();
    uname.nodename().to_string_lossy().into_owned()
}

#[cfg(windows)]
pub(crate) fn local_hostname() -> String {
    use windows_sys::Win32::System::SystemInformation::{
        ComputerNameDnsHostname, GetComputerNameExW,
    };
    // A DNS hostname is at most 255 characters.
    let mut buffer = [0u16; 256];
    let mut len = u32::try_from(buffer.len()).unwrap_or(0);
    // SAFETY: `buffer` holds `len` UTF-16 units; on success the call writes
    // the name there and sets `len` to its length (without the NUL).
    let written =
        unsafe { GetComputerNameExW(ComputerNameDnsHostname, buffer.as_mut_ptr(), &mut len) };
    if written == 0 {
        return String::new();
    }
    let len = usize::try_from(len).unwrap_or(0).min(buffer.len());
    String::from_utf16_lossy(&buffer[..len])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_this_machine() {
        assert!(!local_hostname().is_empty());
    }
}
