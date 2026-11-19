# DaSSHboard

A desktop dashboard for SSH, serial and local-shell devices: save them once,
arrange live terminals in a grid, and reload the whole workspace in one click.

## Devices and trust

**Device**:
A saved target the user can open: an SSH host, a serial port, or a local shell.
_Avoid_: host, server, machine, connection

**Device kind**:
Which of SSH, serial or local shell a Device is.
_Avoid_: connection type, protocol

**Jump host**:
A Device an SSH connection goes through to reach another Device (`-J`).
_Avoid_: bastion, proxy

**Secret**:
A password or key passphrase of a Device, kept only in the OS keychain.
_Avoid_: credential (a Secret is one kind of credential)

**Host key trust**:
The trust-on-first-use record of each SSH host's key. A changed key blocks the
connection until the user accepts it.
_Avoid_: known host (that's the file, not the concept)

**Prompt**:
A question the app asks the user while connecting: accept a host key, or
answer an authentication question (password, one-time code).
_Avoid_: dialog, challenge

## Connections

**SSH connection**:
One authenticated SSH link to a Device, through its Jump hosts if any. A
Session, a Tunnel or the SFTP browser each opens its own.
_Avoid_: transport, handle, link

**Session**:
One live terminal on a Device, whatever its Device kind.
_Avoid_: shell, terminal, channel

**Tunnel**:
The live SSH connection of a Device that carries its Forwards.
_Avoid_: port forwarding (that's the feature, not the thing)

**Forward**:
One named port forward of a Device: local (`-L`), remote (`-R`) or dynamic
SOCKS (`-D`).
_Avoid_: rule, mapping, port forward

**Auto-reconnect**:
Reopening a Session or Tunnel that dropped without the user asking, within a
retry budget.
_Avoid_: retry, resume

**Connection logs**:
The list of connects, drops and their causes, slow requests and stalls since
launch. Never holds Secrets or terminal content.
_Avoid_: debug log, history

## Workspace

**Pane**:
One cell of a Grid, showing at most one Session.
_Avoid_: cell, view, terminal

**Grid**:
The resizable layout of Panes inside a Tab, up to 3×2.
_Avoid_: layout, split

**Tab**:
One Grid in the window's tab bar.
_Avoid_: page, workspace

**Workspace**:
The window's open Tabs with their Grids and Pane devices.
_Avoid_: session (a Session is a single terminal), layout

**Profile**:
A saved Workspace the user can reload. The default Profile reconnects every
Pane on launch.
_Avoid_: preset, saved layout

**Broadcast**:
Sending typed input to several Panes at once.
_Avoid_: multi-input, sync

## Files and commands

**SFTP browser**:
The docked file panel browsing one Device over SFTP.
_Avoid_: file manager, files panel

**Bookmark**:
A saved remote folder of a Device in the SFTP browser.
_Avoid_: favourite, shortcut

**Remote edit**:
A remote file opened in a local editor, where every save is uploaded back.
_Avoid_: sync, live edit

**Commands on connect**:
A Device's snippet, typed in as soon as its shell opens.
_Avoid_: startup script, init command

**Command library**:
The user's saved commands, sent to the focused Pane or to every Pane in
Broadcast.
_Avoid_: snippets, macros
