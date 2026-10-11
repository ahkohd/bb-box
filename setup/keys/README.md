# Signing keys

The keys that sign what the versions resolver follows (#424), which
`SIGNERS` in `src/backends/versions.ts` pins by their primary keys'
fingerprints. gpgv checks each signature against its key, and the
resolver keeps a tool's pin when it does not verify.

| File | Key | Primary fingerprint | From |
| --- | --- | --- | --- |
| `claude-code.asc` | Anthropic Claude Code Release Signing | `31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE` | https://downloads.claude.ai/keys/claude-code.asc |
| `google-linux.asc` | Google Inc. (Linux Packages Signing Authority) | `EB4C 1BFD 4F04 2F6D DDCC EC91 7721 F63B D38B 4796` | https://dl.google.com/linux/linux_signing_key.pub |

Google signs with a subkey it replaces every few years. When it adds one,
fetch the key again from the same URL: the primary fingerprint stays.
