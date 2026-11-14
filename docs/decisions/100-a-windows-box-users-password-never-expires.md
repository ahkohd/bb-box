# 100: A Windows box user's password never expires

Status: accepted, 13 November 2026. Extends [039](039-windows-desktops-are-clones-of-a-template-that-is-not-generalized.md), [046](046-windows-on-a-mac-runs-in-qemu-in-the-tart-backend.md) and [054](054-windows-images-are-refreshed-in-a-box-of-the-current-build.md).

## Context

A Windows box logs its box user in to the desktop automatically, with a random password the image's build sets. Windows' default maximum password age is 42 days. Once the password is older, Windows no longer logs the user in: it shows its sign-in screen and asks for a new password. The box still answers SSH with BB Box's key, but it has no desktop session, so BB's installer cannot join it to BB and computer use has no driver.

A refresh (054) builds the new image in a box of the current one, so the box user, and the date its password was set, carry over from the first build. An image refreshed since then is no younger, as far as the password goes, than the build that made the user.

## Decision

- Every Windows image sets the box user's password never to expire, and the machine's maximum password age to unlimited, at the first logon, the first thing it does. A refresh sets both too, before Windows' updates. The image's check fails a build whose box user's password can expire, and its record lists `password-never-expires`.
- The doctor warns about a Windows image whose record does not list it.
- BB Box repairs a box made from an older image as it starts. When the box answers SSH and its desktop is not up, it reads the box user. Where the password has expired, it sets the same two settings and reads them back. It restarts Windows only when both read back as set, and Windows' own list of sessions (`quser`) says nobody is logged in. It looks once after a box first answers and at each start, and wherever it waits for a desktop: a warm fill, an image refresh's box, a resize, and on a Mac a restored snapshot. A warm box, filled with its desktop up, is not asked again as a box takes it.
- Where the repair cannot be made safely, BB Box does not restart, and says why with the command to run by hand: Windows refused a setting, the settings did not read back, someone is logged in, the session list could not be read, Windows refused the restart, or BB Box has restarted the box for this password once already. A box started that way has a Desktop fact in its status saying it is not ready for computer use. A desktop wait, as for a warm fill, ends at once with the same reason.

The repair is safe to make without a person:

- It restarts only where Windows says nobody is logged in, active or disconnected. Explorer alone does not count: a session whose shell has stopped can still hold someone's work. When the session list cannot be read, it does not restart.
- It sets what the images set from now on, and nothing that lowers the box's security: the password is random, kept only in the box's own automatic logon, and never typed.
- It restarts at most once for a password. It notes the password's last-set date in the box user's home before the restart, and refuses a second restart for the same password. After a successful repair the password no longer expires, so the repair does not match again.

## Consequences

- A box from an older image takes about a minute more to start, once, and BB Box's log says why.
- Each cold start of a Windows box runs one more PowerShell command over SSH, usually under a second, before it is ready. A warm claim runs none.
- Templates built before this still warn in the doctor until they are refreshed or rebuilt.
- A box that is running without its desktop when BB Box is updated is repaired at its next stop and start, or by hand, as the setup guide and the BB Box skill say.
