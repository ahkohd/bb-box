# 010: The repository is publishable at all times

Status: accepted, 30 September 2026.

## Context

bb-box will be open-sourced once it has been used daily for months. Removing
private details later is error-prone, and an outside reader should be able to
use every document.

## Decision

- No deployment details in the repository: no hostnames, addresses, guest
  IDs, pool, bridge or storage names, private network details or personal
  names.
- Every such value is a setting with a generic default. A real deployment's
  values live outside the repository, or in an example settings file clearly
  marked as an example.
- Template builds and host setup are parameterised scripts in the repository.
- Documents are written for an outside reader and describe the design, not
  the history of how it was reached.
- Public names throughout, for example the in-box user `box`.

## Consequences

- Reviews check every change for deployment details.
- Measurements name hardware and software versions, never a host's name.
- Default values must work on a fresh install of each provider, or `doctor`
  must say what to change.
